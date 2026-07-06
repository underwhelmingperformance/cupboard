import { rootLogger } from '@cupboard/logger';
import {
	type NixSha256HashString,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { narObjectKey } from '../http/http.ts';
import {
	blobStateNarHashes,
	cacheWriteGrants,
	clearBlobStorage,
	issueTokenForTenant,
	provisionNamedTenant,
	pushPathToTenant,
	resetTestServer,
	testBase,
	testServerFor,
	uploadMetadata,
	type VerifiableNar,
	verifiableNar
} from '../test-support.ts';

import {
	BlobReaperService,
	type CasReferenceDemoter,
	type DemoteCursor,
	type NarInfoDemoter
} from './blob-reaper-service.ts';

function staticCursor(): DemoteCursor {
	return {
		read: () => Promise.resolve(''),
		advance: () => Promise.resolve()
	};
}

// Records which tenants the reaper routed a demote to, and fails the demote for
// any tenant in `failing`, so a pass can mix a tenant whose de-materialise throws
// with one that succeeds.
function recordingDemoter(
	failing: ReadonlySet<TenantId>,
	routed: TenantId[]
): NarInfoDemoter {
	return {
		demote: (tenant) => {
			routed.push(tenantIdSchema.parse(tenant));

			return failing.has(tenantIdSchema.parse(tenant))
				? Promise.reject(new Error(`demote routing failed for ${tenant}`))
				: Promise.resolve();
		}
	};
}

const rejectingCasDemoter: CasReferenceDemoter = {
	demote: () => Promise.reject(new Error('cas routing failed'))
};

function reaperWith(demoter: NarInfoDemoter): BlobReaperService {
	return new BlobReaperService(
		drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
		env.BLOBS,
		demoter,
		rejectingCasDemoter
	);
}

// Pushes one path into a freshly provisioned tenant and returns the NAR so a
// caller can drop its canonical object and run the reaper over the shared fact.
async function pushNar(
	name: string,
	seed: string,
	storePathHash: string
): Promise<{ tenant: TenantId; nar: VerifiableNar }> {
	const tenant = tenantIdSchema.parse(name);
	const issuer = await provisionNamedTenant(tenant);
	const token = await issueTokenForTenant(
		testServerFor(tenant),
		issuer,
		cacheWriteGrants()
	);
	const nar = await verifiableNar(seed);
	const metadata = uploadMetadata({
		storePathHash,
		references: [],
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});
	await pushPathToTenant(tenant, token, metadata, nar);

	return { tenant, nar };
}

// The reaper batches a missing blob's demote into one routing call per tenant and
// only clears the shared fact once every referencing tenant has been told. A
// tenant whose routing throws keeps every fact it references for the next pass,
// while facts owned solely by tenants that succeeded are still demoted in the
// same pass.
describe('reaper demote routing failure', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();
		await clearBlobStorage();
	});

	it('keeps a shared blob fact when its only tenant demote routing fails', async () => {
		const { tenant, nar } = await pushNar(
			'reaper-fail-solo',
			'solo',
			'a'.repeat(32)
		);
		await env.BLOBS.delete(narObjectKey(nar.narHash));

		const routed: TenantId[] = [];
		const demoted = await reaperWith(
			recordingDemoter(new Set([tenant]), routed)
		).demoteMissingBlobs(rootLogger(), 10, staticCursor());

		expect({
			demoted,
			routed,
			blobState: await blobStateNarHashes()
		}).toStrictEqual({
			// Routing failed, so the fact is left in place for the next pass.
			demoted: 0,
			routed: [tenant],
			blobState: [{ narHash: nar.narHash }]
		});
	});

	it('demotes a succeeding tenant fact while keeping a failing tenant fact', async () => {
		const failing = await pushNar('reaper-fail-a', 'fail', 'a'.repeat(32));
		const succeeding = await pushNar('reaper-ok-b', 'succeed', 'b'.repeat(32));
		await env.BLOBS.delete(narObjectKey(failing.nar.narHash));
		await env.BLOBS.delete(narObjectKey(succeeding.nar.narHash));

		const routed: TenantId[] = [];
		const demoted = await reaperWith(
			recordingDemoter(new Set([failing.tenant]), routed)
		).demoteMissingBlobs(rootLogger(), 10, staticCursor());

		expect({
			demoted,
			routed: routed.toSorted(byCodeUnit),
			blobState: await blobStateNarHashes()
		}).toStrictEqual({
			// Only the succeeding tenant's distinct fact is cleared; the failing
			// tenant's fact survives, and both tenants were routed.
			demoted: 1,
			routed: [failing.tenant, succeeding.tenant].toSorted(byCodeUnit),
			blobState: [{ narHash: failing.nar.narHash }]
		});
	});

	it('keeps a fact shared by a failing and a succeeding tenant', async () => {
		const failing = await pushNar(
			'reaper-shared-fail',
			'shared',
			'a'.repeat(32)
		);
		const sharing = await pushNar('reaper-shared-ok', 'shared', 'b'.repeat(32));

		// Both tenants pushed the same NAR, so they reference one shared fact.
		const sharedHash: NixSha256HashString = failing.nar.narHash;
		expect(sharing.nar.narHash).toBe(sharedHash);
		await env.BLOBS.delete(narObjectKey(sharedHash));

		const routed: TenantId[] = [];
		const demoted = await reaperWith(
			recordingDemoter(new Set([failing.tenant]), routed)
		).demoteMissingBlobs(rootLogger(), 10, staticCursor());

		expect({
			demoted,
			routed: routed.toSorted(byCodeUnit),
			blobState: await blobStateNarHashes()
		}).toStrictEqual({
			// One owning tenant failed, so the shared fact is blocked from deletion
			// even though the other tenant succeeded.
			demoted: 0,
			routed: [failing.tenant, sharing.tenant].toSorted(byCodeUnit),
			blobState: [{ narHash: sharedHash }]
		});
	});
});
