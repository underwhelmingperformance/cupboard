import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	admitTenant,
	refreshTenantMembership
} from '../control/tenant-membership.ts';
import { finaliseOffboardedTenant } from '../control/tenant-registry.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { narObjectKey } from '../http/http.ts';
import {
	afterGrace,
	attemptPushToTenant,
	blobReferenceRows,
	blobStateNarHashes,
	clearBlobStorage,
	deleteTestBase,
	issueTokenForTenant,
	offboardTenant,
	provisionNamedTenant,
	pushPathToTenant,
	resetTestServer,
	tenantBlobRows,
	tenantObjectKeys,
	tenantRow,
	tenantUsagePresent,
	testServerFor,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import { runBlobReaper, runCronTick, runOffboardSweep } from './scheduled.ts';

// Offboarding is a quiesce-then-drain state machine: the control plane marks the
// tenant `offboarding` (stopping new writes and, after the manifest TTL, reads), then
// the cron drains a bounded batch of its reference and presence rows through the
// tenant's own Durable Object and a bounded batch of its R2 objects through the
// Worker. A fully drained tenant is finalised into a terminal scrubbed `offboarded`
// tombstone admission no longer admits, and the shared blobs it released are
// collected by the global reaper.

let nextTenant = 0;

async function admittable(slug: string): Promise<boolean> {
	const ctx = createExecutionContext();
	const entry = await admitTenant(env, ctx, slug);
	await waitOnExecutionContext(ctx);

	return entry !== undefined;
}

async function provisionedWritingTenant(): Promise<{
	id: string;
	token: string;
}> {
	nextTenant += 1;
	const id = `offboard-test-${String(nextTenant)}`;
	const issuer = await provisionNamedTenant(id);
	const token = await issueTokenForTenant(testServerFor(id), issuer, 'write');

	return { id, token };
}

async function pushTenantPath(
	id: string,
	token: string,
	storePathHash: string,
	seed: string
): Promise<string> {
	const nar = await verifiableNar(seed);
	const metadata = uploadMetadata({
		storePathHash,
		references: [],
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});

	await pushPathToTenant(id, token, metadata, nar);

	return nar.narHash;
}

async function tenantEdges(id: string): Promise<
	{
		readonly cache: string;
		readonly storePathHash: string;
		readonly generation: number;
		readonly narHash: string;
	}[]
> {
	const rows = await blobReferenceRows();

	return rows
		.filter((row) => row.tenant === id)
		.map((row) => ({
			cache: row.cache,
			storePathHash: row.storePathHash,
			generation: row.generation,
			narHash: row.narHash
		}));
}

async function tenantPresence(id: string): Promise<
	{
		readonly narHash: string;
		readonly fileSize: number;
	}[]
> {
	const rows = await tenantBlobRows();

	return rows
		.filter((row) => row.tenant === id)
		.map((row) => ({ narHash: row.narHash, fileSize: row.fileSize }));
}

describe('offboarding drain', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(deleteTestBase);
		await resetTestServer();

		await clearBlobStorage();
	});

	it('drains a tenant to a scrubbed tombstone and frees its shared blob', async () => {
		const { id, token } = await provisionedWritingTenant();
		const narHash = await pushTenantPath(
			id,
			token,
			'a'.repeat(32),
			'offboard-one'
		);

		await offboardTenant(id);
		await runOffboardSweep(env);

		const drained = {
			edges: await tenantEdges(id),
			presence: await tenantPresence(id),
			objects: await tenantObjectKeys(id),
			row: await tenantRow(id),
			usage: await tenantUsagePresent(id),
			// The shared blob is now unreferenced but not yet reaped.
			blobState: await blobStateNarHashes()
		};

		// The reaper collects the freed shared blob across its grace.
		await runBlobReaper(env);
		vi.setSystemTime(afterGrace());
		await runBlobReaper(env);

		expect({
			drained,
			blobState: await blobStateNarHashes(),
			narObject: (await env.BLOBS.head(narObjectKey(narHash))) !== null
		}).toStrictEqual({
			drained: {
				edges: [],
				presence: [],
				objects: [],
				row: {
					status: 'offboarded',
					readUser: undefined,
					readPasswordHash: undefined,
					readPasswordSalt: undefined
				},
				usage: false,
				blobState: [{ narHash }]
			},
			blobState: [],
			narObject: false
		});
	});

	it('drains a large tenant over successive bounded ticks, finalising only once empty', async () => {
		const { id, token } = await provisionedWritingTenant();
		const narHashA = await pushTenantPath(
			id,
			token,
			'a'.repeat(32),
			'offboard-multi-a'
		);
		const narHashB = await pushTenantPath(
			id,
			token,
			'b'.repeat(32),
			'offboard-multi-b'
		);

		await offboardTenant(id);

		// One row and one object per tick: the first tick cannot finish, so the tenant
		// stays `offboarding` with residue rather than being finalised early.
		await runOffboardSweep(env, 10, 1, 1);

		const midRow = await tenantRow(id);
		const midDrain = {
			status: midRow?.status,
			edges: await tenantEdges(id),
			presence: await tenantPresence(id),
			objects: await tenantObjectKeys(id)
		};

		// Further ticks drain the remainder and finalise the tenant.
		await runOffboardSweep(env, 10, 1, 1);
		await runOffboardSweep(env, 10, 1, 1);

		const finalRow = await tenantRow(id);

		expect({
			midDrain,
			final: {
				status: finalRow?.status,
				edges: await tenantEdges(id),
				presence: await tenantPresence(id),
				objects: await tenantObjectKeys(id),
				usage: await tenantUsagePresent(id)
			}
		}).toStrictEqual({
			midDrain: {
				status: 'offboarding',
				edges: [
					{
						cache: '',
						storePathHash: 'b'.repeat(32),
						generation: 0,
						narHash: narHashB
					}
				],
				presence: [{ narHash: narHashA, fileSize: 43 }],
				objects: [`t/${id}/narinfo/${'b'.repeat(32)}`]
			},
			final: {
				status: 'offboarded',
				edges: [],
				presence: [],
				objects: [],
				usage: false
			}
		});
	});

	it('bounds NAR edge deletion by exact captured rows', async () => {
		const { id } = await provisionedWritingTenant();
		const storePathHash = 'a'.repeat(32);
		const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });

		await database
			.insert(d1Schema.blobReference)
			.values([
				{
					tenant: id,
					cache: '',
					storePathHash,
					generation: 0,
					narHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
				},
				{
					tenant: id,
					cache: 'builds',
					storePathHash,
					generation: 1,
					narHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
				},
				{
					tenant: id,
					cache: 'tests',
					storePathHash,
					generation: 2,
					narHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccc'
				}
			])
			.run();

		const result = await testServerFor(id).runOffboard(1);
		const rows = await blobReferenceRows();
		const remaining = rows
			.filter((row) => row.tenant === id)
			.map((row) => ({
				cache: row.cache,
				storePathHash: row.storePathHash,
				generation: row.generation,
				narHash: row.narHash
			}));

		expect({ result, remaining }).toStrictEqual({
			result: { drained: false },
			remaining: [
				{
					cache: 'builds',
					storePathHash,
					generation: 1,
					narHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
				},
				{
					cache: 'tests',
					storePathHash,
					generation: 2,
					narHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccc'
				}
			]
		});
	});

	it('refuses a commit that settles after offboarding began, publishing no edge', async () => {
		const { id, token } = await provisionedWritingTenant();
		const narHash = await pushTenantPath(
			id,
			token,
			'a'.repeat(32),
			'offboard-gate-a'
		);

		// Mark the Durable Object offboarding while leaving the D1 status active, so the
		// Worker still admits the write: this mimics a commit that passed the write gate
		// and is now settling in the object after offboarding began.
		await testServerFor(id).beginOffboard();

		const nar = await verifiableNar('offboard-gate-b');
		const metadata = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const status = await attemptPushToTenant(id, token, metadata, nar);

		// The commit is refused and, crucially, no second edge is published: only the
		// pre-offboarding path's edge remains, so the drain cannot be outrun.
		expect({ status, edges: await tenantEdges(id) }).toStrictEqual({
			status: StatusCodes.FORBIDDEN,
			edges: [
				{
					cache: '',
					storePathHash: 'a'.repeat(32),
					generation: 0,
					narHash
				}
			]
		});
	});

	it('never admits a tombstone left by an interrupted finalisation, before or after the refresh', async () => {
		const { id } = await provisionedWritingTenant();

		// Plant the crash state: the D1 row is finalised to the `offboarded` tombstone
		// (status flipped, scrubbed, usage dropped) but the membership filter still
		// lists the slug, so admission still reaches the authoritative row read.
		await finaliseOffboardedTenant(
			drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
			id
		);
		// The row read fails closed on the tombstone, so the slug 404s at once despite
		// the stale filter; the next rebuild then drops it from the filter too.
		const before = await admittable(id);

		await refreshTenantMembership(env);
		const after = await admittable(id);

		expect({ before, after }).toStrictEqual({ before: false, after: false });
	});

	it('finalises an offboarding tenant within the cron tick and frees its blob, never resurrecting it', async () => {
		const { id, token } = await provisionedWritingTenant();
		const narHash = await pushTenantPath(
			id,
			token,
			'a'.repeat(32),
			'offboard-cron'
		);

		await offboardTenant(id);

		// The whole tick: the maintenance sweep skips the offboarding tenant, the
		// offboard pass drains and finalises it, and the reaper arms its freed blob.
		await runCronTick(env);
		vi.setSystemTime(afterGrace());
		await runCronTick(env);

		const row = await tenantRow(id);

		expect({
			status: row?.status,
			edges: await tenantEdges(id),
			objects: await tenantObjectKeys(id),
			blobState: await blobStateNarHashes(),
			narObject: (await env.BLOBS.head(narObjectKey(narHash))) !== null
		}).toStrictEqual({
			status: 'offboarded',
			edges: [],
			objects: [],
			blobState: [],
			narObject: false
		});
	});
});
