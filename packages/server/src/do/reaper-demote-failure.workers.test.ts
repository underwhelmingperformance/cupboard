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
import {
	blobStateNarHashes,
	cacheWriteGrants,
	clearBlobStorage,
	currentNarObjectKey,
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

describe('reaper demote routing failure', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();
		await clearBlobStorage();
	});

	it('keeps global blob state when its only tenant demotion fails', async () => {
		const { tenant, nar } = await pushNar(
			'reaper-fail-solo',
			'solo',
			'a'.repeat(32)
		);
		await env.BLOBS.delete(await currentNarObjectKey(nar.narHash));

		const routed: TenantId[] = [];
		const demoted = await reaperWith(
			recordingDemoter(new Set([tenant]), routed)
		).demoteMissingBlobs(rootLogger(), 10, staticCursor());

		expect({
			demoted,
			routed,
			blobState: await blobStateNarHashes()
		}).toStrictEqual({
			demoted: 0,
			routed: [tenant],
			blobState: [{ narHash: nar.narHash }]
		});
	});

	it('removes one blob-state row while retaining the row whose tenant demotion fails', async () => {
		const failing = await pushNar('reaper-fail-a', 'fail', 'a'.repeat(32));
		const succeeding = await pushNar('reaper-ok-b', 'succeed', 'b'.repeat(32));
		await env.BLOBS.delete(await currentNarObjectKey(failing.nar.narHash));
		await env.BLOBS.delete(await currentNarObjectKey(succeeding.nar.narHash));

		const routed: TenantId[] = [];
		const demoted = await reaperWith(
			recordingDemoter(new Set([failing.tenant]), routed)
		).demoteMissingBlobs(rootLogger(), 10, staticCursor());

		expect({
			demoted,
			routed: routed.toSorted(byCodeUnit),
			blobState: await blobStateNarHashes()
		}).toStrictEqual({
			demoted: 1,
			routed: [failing.tenant, succeeding.tenant].toSorted(byCodeUnit),
			blobState: [{ narHash: failing.nar.narHash }]
		});
	});

	it('keeps a shared blob-state row when any tenant demotion fails', async () => {
		const failing = await pushNar(
			'reaper-shared-fail',
			'shared',
			'a'.repeat(32)
		);
		const sharing = await pushNar('reaper-shared-ok', 'shared', 'b'.repeat(32));

		const sharedHash: NixSha256HashString = failing.nar.narHash;
		expect(sharing.nar.narHash).toBe(sharedHash);
		await env.BLOBS.delete(await currentNarObjectKey(sharedHash));

		const routed: TenantId[] = [];
		const demoted = await reaperWith(
			recordingDemoter(new Set([failing.tenant]), routed)
		).demoteMissingBlobs(rootLogger(), 10, staticCursor());

		expect({
			demoted,
			routed: routed.toSorted(byCodeUnit),
			blobState: await blobStateNarHashes()
		}).toStrictEqual({
			demoted: 0,
			routed: [failing.tenant, sharing.tenant].toSorted(byCodeUnit),
			blobState: [{ narHash: sharedHash }]
		});
	});
});
