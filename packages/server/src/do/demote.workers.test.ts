import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { runReaperDemote } from '../routing/scheduled.ts';
import {
	blobReferenceRows,
	blobStateNarHashes,
	cacheWriteGrants,
	clearBlobStorage,
	deleteTestBase,
	issueTokenForTenant,
	provisionNamedTenant,
	pushPathToTenant,
	resetTestServer,
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

let nextTenant = 0;

async function committedTenantPath(seed: string) {
	nextTenant += 1;
	const tenant = `demote-test-${String(nextTenant)}`;
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
	storePathHash: string
): Promise<boolean> {
	const object = await env.BLOBS.head(narInfoObjectKey(tenant, storePathHash));

	return object !== null;
}

async function narPresent(narHash: string): Promise<boolean> {
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
		vi.setSystemTime(deleteTestBase);
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

		const demoted = await runReaperDemote(env);

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

	it('leaves a blob whose object is present untouched', async () => {
		const { tenant, metadata, narHash } =
			await committedTenantPath('demote-present');

		const demoted = await runReaperDemote(env);

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
		await runReaperDemote(env);

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
