import { rootLogger } from '@cupboard/logger';
import {
	type NixSha256HashString,
	type StorePathHash,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { runReaperDemote } from '../routing/scheduled.ts';
import {
	blobReferenceRows,
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
	verifiableNar
} from '../test-support.ts';

// The reaper's demote pass walks `blob_state` for a shared object that has gone
// missing (the "available but no object" gap a crash can leave). Because reads serve
// from a tenant's narinfo object and never from `blob_state`, demotion de-materialises
// the referencing narinfos through their owning Durable Object first, then deletes the
// `blob_state` fact last so the fact re-drives an interrupted run. Any correct
// re-upload re-promotes and heals the path.
//
// Each test runs against its own freshly named tenant pushed through the real Worker,
// so the Durable Object the reaper routes to by tenant slug is the one that holds the
// data: the harness rotates the fixture tenant's object id per test, so the
// fixture slug would route the reaper to an empty object instead.

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

async function narInfoPresent(
	tenant: string,
	storePathHash: StorePathHash
): Promise<boolean> {
	const object = await env.BLOBS.head(narInfoObjectKey(tenant, storePathHash));

	return object !== null;
}

async function narPresent(narHash: NixSha256HashString): Promise<boolean> {
	const object = await env.BLOBS.head(narObjectKey(narHash));

	return object !== null;
}

async function edgeCount(): Promise<number> {
	const edges = await blobReferenceRows();

	return edges.length;
}

describe('reaper demote pass', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();

		await clearBlobStorage();
	});

	it('demotes a blob whose object has gone and de-materialises its narinfos', async () => {
		const { tenant, metadata, narHash } =
			await committedTenantPath('demote-basic');

		// Plant the gap: the shared object is gone, but its fact, its edge and the
		// materialised narinfo all survive.
		await env.BLOBS.delete(narObjectKey(narHash));

		expect({
			narPresent: await narPresent(narHash),
			narInfoPresent: await narInfoPresent(tenant, metadata.storePathHash),
			blobState: await blobStateNarHashes(),
			edges: await edgeCount()
		}).toStrictEqual({
			narPresent: false,
			narInfoPresent: true,
			blobState: [{ narHash }],
			edges: 1
		});

		const demoted = await runReaperDemote(rootLogger(), env);

		// The fact is gone and the narinfo de-materialised, so the read path stops
		// serving a narinfo whose NAR is missing. The edge stays: the path still wants
		// the hash, and a re-upload heals it.
		expect({
			demoted,
			blobState: await blobStateNarHashes(),
			narInfoPresent: await narInfoPresent(tenant, metadata.storePathHash),
			edges: await edgeCount()
		}).toStrictEqual({
			demoted: 1,
			blobState: [],
			narInfoPresent: false,
			edges: 1
		});
	});

	it('demotes a shared blob through every referencing tenant in one pass', async () => {
		// Two tenants push identical content, so they share one `blob_state` row but
		// each holds its own narinfo object and edge. One demote pass must route to
		// both owning tenants and then drop the single shared fact.
		const first = await committedTenantPath('demote-shared');
		const second = await committedTenantPath('demote-shared');

		await env.BLOBS.delete(narObjectKey(first.narHash));

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
			firstNarInfo: await narInfoPresent(
				first.tenant,
				first.metadata.storePathHash
			),
			secondNarInfo: await narInfoPresent(
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

	it('leaves a blob whose object is present untouched', async () => {
		const { tenant, metadata, narHash } =
			await committedTenantPath('demote-present');

		const demoted = await runReaperDemote(rootLogger(), env);

		expect({
			demoted,
			blobState: await blobStateNarHashes(),
			narInfoPresent: await narInfoPresent(tenant, metadata.storePathHash),
			narPresent: await narPresent(narHash)
		}).toStrictEqual({
			demoted: 0,
			blobState: [{ narHash }],
			narInfoPresent: true,
			narPresent: true
		});
	});

	it('heals on a re-upload after a demote', async () => {
		const { tenant, token, metadata, nar, narHash } =
			await committedTenantPath('demote-heal');

		await env.BLOBS.delete(narObjectKey(narHash));
		await runReaperDemote(rootLogger(), env);

		// A correct re-push re-promotes the shared object and re-materialises the
		// narinfo, so the path serves again.
		await pushPathToTenant(tenant, token, metadata, nar);

		expect({
			blobState: await blobStateNarHashes(),
			narInfoPresent: await narInfoPresent(tenant, metadata.storePathHash),
			narPresent: await narPresent(narHash)
		}).toStrictEqual({
			blobState: [{ narHash }],
			narInfoPresent: true,
			narPresent: true
		});
	});
});
