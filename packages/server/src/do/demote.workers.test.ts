import { rootLogger } from '@cupboard/logger';
import {
	type NixSha256HashString,
	type StorePathHash,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfoObjectKey } from '../http/http.ts';
import { runReaperDemote } from '../routing/scheduled.ts';
import {
	blobReferenceRows,
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
	verifiableNar
} from '../test-support.ts';

// Remove tenant narinfo objects before deleting the shared `blob_state` row.
// If a pass stops early, that row makes the next pass try again. Keep reference
// edges so another upload of the missing NAR can restore the narinfo objects.
//
// Use a separately provisioned tenant for each test. The reaper routes by tenant
// slug, but the test harness rotates the fixture Durable Object ID without
// changing its slug; using the fixture tenant would route to an empty object.

function* countFromOne(): Generator<number, never> {
	for (let value = 1; ; value++) {
		yield value;
	}
}

const tenantNumbers = countFromOne();

async function committedTenantPath(seed: string) {
	const tenant = tenantIdSchema.parse(
		`demote-test-${String(tenantNumbers.next().value)}`
	);
	const issuer = await provisionNamedTenant(tenant);
	const token = await issueTokenForTenant(
		testServerFor(tenant),
		issuer,
		cacheWriteGrants()
	);
	const nar = await verifiableNar(seed);
	const metadata = uploadMetadata({
		storePathHash: 'a'.repeat(32),
		references: [],
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});

	await pushPathToTenant(tenant, token, metadata, nar);

	return { tenant, token, metadata, nar, narHash: nar.narHash };
}

async function isNarInfoPresent(
	tenant: TenantId,
	storePathHash: StorePathHash
): Promise<boolean> {
	const object = await env.BLOBS.head(
		narInfoObjectKey(tenant, storePathHash, { kind: 'default' })
	);

	return object !== null;
}

async function isNarPresent(narHash: NixSha256HashString): Promise<boolean> {
	const object = await env.BLOBS.head(await currentNarObjectKey(narHash));

	return object !== null;
}

async function edgeCount(): Promise<number> {
	const edges = await blobReferenceRows();

	return edges.length;
}

describe('missing blob demotion', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();

		await clearBlobStorage();
	});

	it('removes narinfo objects and the `blob_state` row for a missing NAR', async () => {
		const { tenant, metadata, narHash } =
			await committedTenantPath('demote-basic');

		// Delete the shared NAR while leaving its `blob_state` row, tenant
		// reference and materialised narinfo in place.
		await env.BLOBS.delete(await currentNarObjectKey(narHash));

		expect({
			isNarPresent: await isNarPresent(narHash),
			isNarInfoPresent: await isNarInfoPresent(tenant, metadata.storePathHash),
			blobState: await blobStateNarHashes(),
			edges: await edgeCount()
		}).toStrictEqual({
			isNarPresent: false,
			isNarInfoPresent: true,
			blobState: [{ narHash }],
			edges: 1
		});

		const demoted = await runReaperDemote(rootLogger(), env);

		expect({
			demoted,
			blobState: await blobStateNarHashes(),
			isNarInfoPresent: await isNarInfoPresent(tenant, metadata.storePathHash),
			edges: await edgeCount()
		}).toStrictEqual({
			demoted: 1,
			blobState: [],
			isNarInfoPresent: false,
			edges: 1
		});
	});

	it('removes narinfo objects for every tenant that references a missing NAR', async () => {
		const first = await committedTenantPath('demote-shared');
		const second = await committedTenantPath('demote-shared');

		await env.BLOBS.delete(await currentNarObjectKey(first.narHash));

		expect({
			sharedHash: first.narHash === second.narHash,
			blobState: await blobStateNarHashes(),
			edges: await edgeCount()
		}).toStrictEqual({
			sharedHash: true,
			blobState: [{ narHash: first.narHash }],
			edges: 2
		});

		const demoted = await runReaperDemote(rootLogger(), env);

		expect({
			demoted,
			blobState: await blobStateNarHashes(),
			firstNarInfo: await isNarInfoPresent(
				first.tenant,
				first.metadata.storePathHash
			),
			secondNarInfo: await isNarInfoPresent(
				second.tenant,
				second.metadata.storePathHash
			),
			edges: await edgeCount()
		}).toStrictEqual({
			demoted: 1,
			blobState: [],
			firstNarInfo: false,
			secondNarInfo: false,
			edges: 2
		});
	});

	it('keeps narinfo objects and the `blob_state` row while the NAR is present', async () => {
		const { tenant, metadata, narHash } =
			await committedTenantPath('demote-present');

		const demoted = await runReaperDemote(rootLogger(), env);

		expect({
			demoted,
			blobState: await blobStateNarHashes(),
			isNarInfoPresent: await isNarInfoPresent(tenant, metadata.storePathHash),
			isNarPresent: await isNarPresent(narHash)
		}).toStrictEqual({
			demoted: 0,
			blobState: [{ narHash }],
			isNarInfoPresent: true,
			isNarPresent: true
		});
	});

	it('serves the path after the missing NAR is uploaded again', async () => {
		const { tenant, token, metadata, nar, narHash } =
			await committedTenantPath('demote-heal');

		await env.BLOBS.delete(await currentNarObjectKey(narHash));
		await runReaperDemote(rootLogger(), env);

		await pushPathToTenant(tenant, token, metadata, nar);

		expect({
			blobState: await blobStateNarHashes(),
			isNarInfoPresent: await isNarInfoPresent(tenant, metadata.storePathHash),
			isNarPresent: await isNarPresent(narHash)
		}).toStrictEqual({
			blobState: [{ narHash }],
			isNarInfoPresent: true,
			isNarPresent: true
		});
	});
});
