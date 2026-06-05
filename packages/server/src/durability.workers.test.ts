import { NarInfo } from '@cupboard/nix/narinfo';
import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { narInfos, signingKeys } from './db/schema.ts';
import {
	authorisedFetch,
	blobStateNarHashes,
	bootstrap,
	currentOrigin,
	narBytes,
	pushPath,
	readStoredNarInfo,
	resetTestServer,
	testServerFor,
	uploadMetadata,
	useTestServer,
	verifyNarInfoSignature
} from './test-support.ts';

// The vitest-pool-workers harness exposes no API to force a Durable Object to be
// evicted and re-instantiated, so durability is asserted two ways: the per-DO
// rows are read straight from the persisted SQLite (`state.storage`), the shared
// blob facts from D1, and a fresh stub for the same DO name re-derives `/pubkey`
// from that storage.

describe('durable object state', () => {
	beforeEach(resetTestServer);

	it('persists the signing key set and committed metadata in their final shapes', async () => {
		useTestServer('durability-rows');
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(init.token, metadata);

		const persisted = await runInDurableObject(
			testServerFor('durability-rows'),
			(_instance, state) => {
				const database = drizzle(state.storage, {
					schema: { narInfos, signingKeys }
				});

				return {
					signingKeys: database
						.select({
							signing: signingKeys.signing,
							published: signingKeys.published
						})
						.from(signingKeys)
						.all(),
					narInfos: database
						.select({
							cache: narInfos.cache,
							storePathHash: narInfos.storePathHash,
							sigsJson: narInfos.sigsJson
						})
						.from(narInfos)
						.all()
				};
			}
		);

		const narInfoRows = persisted.narInfos.map((row) => ({
			cache: row.cache,
			storePathHash: row.storePathHash,
			sigCount: (JSON.parse(row.sigsJson) as string[]).length
		}));

		expect({
			signingKeys: persisted.signingKeys,
			narInfoRows,
			blobState: await blobStateNarHashes()
		}).toStrictEqual({
			signingKeys: [{ signing: true, published: true }],
			narInfoRows: [
				{ cache: '', storePathHash: metadata.storePathHash, sigCount: 1 }
			],
			blobState: [{ narHash: metadata.narHash }]
		});
	});

	it('serves an identical pubkey and a working token after re-instantiation', async () => {
		useTestServer('durability-reads');
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(init.token, metadata);

		// A fresh stub for the same DO name reads the persisted signing key.
		const pubkeyResponse = await testServerFor('durability-reads').fetch(
			new URL('/pubkey', currentOrigin())
		);
		const pubkey = await pubkeyResponse.text();

		// A second bootstrap mints a JWT from the persisted auth key; it must be
		// accepted by an admin route.
		const second = await bootstrap();
		const stats = await authorisedFetch('/stats', second.token);

		const stored = await readStoredNarInfo(metadata.storePathHash);
		const committedVerifies = await verifyNarInfoSignature(
			NarInfo.parse(stored.body),
			init.publicKey
		);

		expect({
			pubkeyMatches: pubkey === `${init.publicKey}\n`,
			secondTokenAccepted: stats.ok,
			committedVerifies
		}).toStrictEqual({
			pubkeyMatches: true,
			secondTokenAccepted: true,
			committedVerifies: true
		});
	});
});
