import { startCapture } from '@cupboard/logger/testing';
import {
	authKeyIdSchema,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	rootNameSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { oidcSubjectSchema, trustRuleIdSchema } from '@cupboard/protocol/oidc';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import {
	currentServer,
	initialise,
	negotiateViaInstance,
	resetTestServer
} from '../test-support.ts';

import { MaintenanceEligibilityService } from './maintenance-eligibility-service.ts';

const methodLineSchema = z.object({
	method: z.string(),
	rowsRead: z.number(),
	rowsWritten: z.number()
});

// Captures the row cost a direct, non-`fetch` entrypoint logs, by reading the
// `method finished` line it emits while `run` executes.
async function maintenancePassCost(
	method: string,
	run: () => Promise<unknown>
): Promise<{
	isLogged: boolean;
	rowsRead: number;
}> {
	const capture = startCapture();

	try {
		await run();
	} finally {
		capture.stop();
	}

	const line = capture.logs
		.filter((entry) => entry.message === 'method finished')
		.map((entry) => methodLineSchema.parse(entry.properties))
		.find((entry) => entry.method === method);

	return { isLogged: line !== undefined, rowsRead: line?.rowsRead ?? -1 };
}

// A push runs the upload procedures once per store path, so any per-path work that
// scales with the in-flight upload set turns a push into a quadratic read load on
// the Durable Object's SQLite (the failure that breached the row-read free tier).
// Negotiating a fresh path must read only that path's own rows, never the whole
// pending-upload set.
//
// Each negotiate, including the synchronous reconcile it now runs, is measured on a
// single object call. This guards that the per-path read stays flat against the
// backlog: both the negotiate's own lookups and the reconcile's existence/soonest
// checks are index-backed, so neither scales with the in-flight set.
describe('upload negotiation cost', () => {
	beforeEach(resetTestServer);

	it('does not scale with the pending-upload backlog', async () => {
		const token = await initialise();

		const emptyBacklogCost = await negotiateCost(token, 'a'.repeat(32));

		await seedPendingUploads(200);

		const largeBacklogCost = await negotiateCost(token, 'b'.repeat(32));

		// The read is the same handful of rows whatever the backlog: assert the exact
		// figure, so a constant baseline regression cannot hide behind an inequality.
		expect({ emptyBacklogCost, largeBacklogCost }).toStrictEqual({
			emptyBacklogCost: 14,
			largeBacklogCost: 14
		});
	});

	// The reconcile reaches the soonest-expiring upload, attestation, root, grace
	// deadline and key retirement through the maintenance indexes, and decides "due
	// now" by existence rather than a count, so its read count is the same handful
	// whatever the backlog. This is what makes the synchronous per-mutation
	// reconcile affordable and what these indexes buy: drop any index those lookups
	// use and the matching scan becomes a full table scan, so the large-backlog
	// figure climbs and the assertion fails.
	it('reconciles without scanning the maintenance backlogs', async () => {
		await initialise();

		await seedReconcileBacklog(3, 'small');
		const smallBacklogCost = await reconcileCost();

		await seedReconcileBacklog(197, 'large');
		const largeBacklogCost = await reconcileCost();

		expect({ smallBacklogCost, largeBacklogCost }).toStrictEqual({
			smallBacklogCost: 9,
			largeBacklogCost: 9
		});
	});

	// "Due now" is decided by whether any deletion is queued, not how many, so the
	// reconcile checks existence (one indexed row).
	// That is what lets it run synchronously on every mutation: the read stays flat
	// however large the deletion backlog grows. Drop to a `COUNT(*)` and the large
	// figure would climb.
	it('reconciles without counting the queued narinfo-deletion backlog', async () => {
		await initialise();

		await seedNarInfoDeletions(3, 0);
		const smallBacklogCost = await reconcileCost();

		await seedNarInfoDeletions(197, 3);
		const largeBacklogCost = await reconcileCost();

		expect({ smallBacklogCost, largeBacklogCost }).toStrictEqual({
			smallBacklogCost: 4,
			largeBacklogCost: 4
		});
	});

	// The "awaiting verification" check is an existence probe, not a count: it stops at
	// the first matching row and short-circuits the rest of the reconcile. Every seeded
	// row matches the `verdict` filter, so the `LIMIT 1` returns at once whether or not
	// the index is used; what this locks is the existence-vs-count shape (a `COUNT(*)`
	// would read one row per pending upload), the populated-match branch the deletion
	// test above leaves empty. The `verdict` index itself is pinned by the
	// maintenance-backlog scan test above.
	it('reconciles without counting the pending-verification backlog', async () => {
		await initialise();

		await seedPendingUploads(3, 'pending-small', 'pending');
		const smallBacklogCost = await reconcileCost();

		await seedPendingUploads(197, 'pending-large', 'committing');
		const largeBacklogCost = await reconcileCost();

		expect({ smallBacklogCost, largeBacklogCost }).toStrictEqual({
			smallBacklogCost: 4,
			largeBacklogCost: 3
		});
	});
});

async function seedNarInfoDeletions(
	count: number,
	generationOffset: number
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < count; index += 1) {
			instance.context.db
				.insert(schema.narInfoDeletions)
				.values({
					cache: '',
					storePathHash: storePathHashSchema.parse('a'.repeat(32)),
					narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
					generation: narInfoGenerationSchema.parse(generationOffset + index),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
				})
				.run();
		}
	});
}

// The maintenance passes bypass `fetch`, so each is wrapped in `metered()` to log
// its row cost. Drop a wrapper and the cost goes dark, so assert each pass emits
// its line.
describe('maintenance pass cost', () => {
	beforeEach(resetTestServer);

	const passes = [
		{
			method: 'garbage-collection',
			run: () => currentServer().runGarbageCollection()
		},
		{ method: 'verification', run: () => currentServer().runVerification() },
		{
			method: 'auth-key-retirement',
			run: () => currentServer().runAuthKeyRetirement()
		},
		{ method: 'offboard', run: () => currentServer().runOffboard(10) },
		{
			method: 'demote-narinfo-objects',
			run: () =>
				currentServer().demoteNarInfoObjects([
					{
						narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
						targets: []
					}
				])
		},
		{
			method: 'demote-attestation-references',
			run: () =>
				currentServer().demoteAttestationReferences([
					{
						digest: sha256HexDigestSchema.parse('b'.repeat(64)),
						fenceStoredAt: isoTimestampSchema.parse('2000-01-01T00:00:00.000Z')
					}
				])
		}
	] as const;

	it.each(passes)('logs a cost line for the $method pass', async (pass) => {
		await initialise();

		const { isLogged } = await maintenancePassCost(pass.method, pass.run);

		expect(isLogged).toBe(true);
	});

	// The garbage collection deletes expired refresh tokens through the
	// `refresh_token` expiry index. No reconcile reads that table, so this is the one
	// guard on that index: drop it and the delete scans the whole token backlog, so
	// the large-backlog pass reads more than the small one.
	it('deletes expired refresh tokens without scanning the backlog', async () => {
		await initialise();

		await seedRefreshTokens(3, 'small');
		const smallBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);

		await seedRefreshTokens(197, 'large');
		const largeBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);

		expect({
			smallBacklogCost: smallBacklog.rowsRead,
			largeBacklogCost: largeBacklog.rowsRead
		}).toStrictEqual({
			smallBacklogCost: 45,
			largeBacklogCost: 45
		});
	});

	it('finds expired roots without scanning the live-root backlog', async () => {
		await initialise();

		await seedLiveRoots(3, 'small');
		await seedExpiredRoot('expired-small');
		const smallBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);

		await seedLiveRoots(197, 'large');
		await seedExpiredRoot('expired-large');
		const largeBacklog = await maintenancePassCost('garbage-collection', () =>
			currentServer().runGarbageCollection()
		);

		expect({
			smallBacklogCost: smallBacklog.rowsRead,
			largeBacklogCost: largeBacklog.rowsRead
		}).toStrictEqual({
			smallBacklogCost: 50,
			largeBacklogCost: 50
		});
	});
});

async function seedRefreshTokens(count: number, label: string): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < count; index += 1) {
			instance.context.db
				.insert(schema.refreshTokens)
				.values({
					id: `${label}-${String(index)}`,
					secretHash: 'hash',
					ruleId: trustRuleIdSchema.parse('rule'),
					subject: oidcSubjectSchema.parse('subject'),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					// Far-future expiry so the pass deletes none and the read count is the
					// index seek alone, not the cost of deleting rows.
					expiresAt: isoTimestampSchema.parse('2099-01-01T00:00:00.000Z')
				})
				.run();
		}
	});
}

// Rows the Durable Object read while rebuilding the eligibility projection,
// measured from the meter either side of a single reconcile.
async function reconcileCost(): Promise<number> {
	return runInDurableObject(currentServer(), async (instance) => {
		const service = new MaintenanceEligibilityService(instance.context);
		const { dbCost } = instance.context;
		dbCost.settle();
		const before = dbCost.rowsRead;

		await service.reconcile();

		dbCost.settle();

		return dbCost.rowsRead - before;
	});
}

async function seedLiveRoots(count: number, label: string): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < count; index += 1) {
			const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

			instance.context.db
				.insert(schema.retentionRoots)
				.values({
					cache: '',
					name: rootNameSchema.parse(`${label}-${String(index)}`),
					expiresAt: isoTimestampSchema.parse('2999-01-01T00:00:00.000Z'),
					createdAt: now,
					updatedAt: now
				})
				.run();
		}
	});
}

async function seedExpiredRoot(name: string): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		const now = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');

		instance.context.db
			.insert(schema.retentionRoots)
			.values({
				cache: '',
				name: rootNameSchema.parse(name),
				expiresAt: now,
				createdAt: now,
				updatedAt: now
			})
			.run();
	});
}

// Rows the Durable Object read while negotiating one fresh path, including the
// synchronous reconcile the mutation now runs. The whole measurement runs on one
// object call so no other request's statements fall between the readings.
async function negotiateCost(
	token: string,
	storePathHash: string
): Promise<number> {
	return runInDurableObject(currentServer(), async (instance) => {
		const { dbCost } = instance.context;
		dbCost.settle();
		const before = dbCost.rowsRead;

		const response = await negotiateViaInstance(instance, token, storePathHash);
		expect(response.status).toBe(StatusCodes.OK);

		dbCost.settle();

		return dbCost.rowsRead - before;
	});
}

async function seedPendingUploads(
	count: number,
	label = 'backlog',
	verdict?: typeof schema.pendingUploads.$inferSelect.verdict
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < count; index += 1) {
			instance.context.db
				.insert(schema.pendingUploads)
				.values({
					id: uploadIdSchema.parse(`${label}-${String(index)}`),
					cache: '',
					narHash: nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`),
					r2Key: r2ObjectKeySchema.parse(`staging/backlog-${String(index)}`),
					metadataJson: '{}',
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					expiresAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z'),
					verdict
				})
				.run();
		}
	});
}

// The Nix base32 alphabet (no e, o, t or u), for fabricating distinct
// syntactically valid store-path hashes when a test seeds grace deadlines in
// volume: `retention_grace`'s primary key is `(cache, store_path_hash)`, so
// each seeded row needs its own hash. The counter is closed over rather than
// module-level, so it advances across every call in this file and two backlogs
// seeded into the same Durable Object (a small one followed by a large one)
// never collide.
const storePathHashAlphabet = '0123456789abcdfghijklmnpqrsvwxyz';

const syntheticStorePathHash = (() => {
	let counter = 0;

	return () => {
		let remaining = counter;
		let suffix = '';

		counter += 1;

		for (let position = 0; position < 8; position += 1) {
			suffix = storePathHashAlphabet.charAt(remaining % 32) + suffix;
			remaining = Math.floor(remaining / 32);
		}

		return storePathHashSchema.parse(`${'0'.repeat(24)}${suffix}`);
	};
})();

// Seeds a backlog in every table the reconcile reaches by index: the pending
// uploads, plus the pending attestations, retention roots, retention grace
// deadlines and retirable auth keys whose soonest-expiry lookups use the other
// maintenance indexes.
async function seedReconcileBacklog(
	count: number,
	label: string
): Promise<void> {
	await seedPendingUploads(count, label);
	await runInDurableObject(currentServer(), (instance) => {
		for (let index = 0; index < count; index += 1) {
			const id = `${label}-${String(index)}`;

			instance.context.db
				.insert(schema.pendingAttestations)
				.values({
					id: uploadIdSchema.parse(id),
					cache: '',
					storePathHash: storePathHashSchema.parse('a'.repeat(32)),
					digest: sha256HexDigestSchema.parse('b'.repeat(64)),
					r2Key: r2ObjectKeySchema.parse(`staging/attestation/${id}`),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					expiresAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
				})
				.run();
			instance.context.db
				.insert(schema.retentionRoots)
				.values({
					cache: '',
					name: rootNameSchema.parse(id),
					expiresAt: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z'),
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					updatedAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
				})
				.run();
			instance.context.db
				.insert(schema.retentionGrace)
				.values({
					cache: '',
					storePathHash: syntheticStorePathHash(),
					retainUntil: isoTimestampSchema.parse('2026-01-02T00:00:00.000Z')
				})
				.run();
			instance.context.db
				.insert(schema.authKeys)
				.values({
					id,
					kid: authKeyIdSchema.parse(id),
					privateJwkJson: '{}',
					publicJwkJson: '{}',
					createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z'),
					scheduledRetireAt: isoTimestampSchema.parse(
						'2026-01-02T00:00:00.000Z'
					)
				})
				.run();
		}
	});
}
