import { NarInfo } from '@cupboard/nix-store/narinfo';
import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { narInfos, signingKeys } from '../db/schema.ts';
import { StoredSignaturesInvalidError } from '../errors.ts';
import { parseStored } from '../http/parse.ts';
import {
	authorisedFetch,
	blobStateNarHashes,
	bootstrap,
	currentOrigin,
	defaultCache,
	defaultCacheStatsPath,
	isNarInfoSignatureValid,
	narBytes,
	pushPath,
	readStoredNarInfo,
	resetTestServer,
	testServerFor,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import { storedSignaturesSchema } from './signing-keys.ts';

function signatureShape(signature: string): {
	readonly keyName: string;
	readonly rawBytes: number;
} {
	const [keyName, encoded] = z
		.tuple([z.string(), z.string()])
		.parse(signature.split(':'));

	return {
		keyName,
		rawBytes: Uint8Array.from(
			atob(encoded),
			(character) => character.codePointAt(0) ?? 0
		).byteLength
	};
}

// The worker test harness cannot evict and re-instantiate a Durable Object.
// These tests inspect persisted SQLite and D1 rows directly, then make later
// requests through a new stub for the same object name. They do not prove that
// a cold instance reconstructs its state correctly.

describe('durable object state', () => {
	beforeEach(resetTestServer);

	it('persists the signing key set and committed metadata in their final shapes', async () => {
		await useTestServer('durability-rows');
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(init.token, metadata);

		const persisted = await runInDurableObject(
			testServerFor('durability-rows'),
			(instance, state) => {
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
							cacheId: narInfos.cacheId,
							storePathHash: narInfos.storePathHash,
							sigsJson: narInfos.sigsJson
						})
						.from(narInfos)
						.all()
						.map((row) => ({
							cache: instance.context.cacheRepository.scopeForId(row.cacheId),
							storePathHash: row.storePathHash,
							sigsJson: row.sigsJson
						}))
				};
			}
		);

		const narInfoRows = persisted.narInfos.map((row) => ({
			cache: row.cache,
			storePathHash: row.storePathHash,
			signatures: parseStored(
				storedSignaturesSchema,
				row.sigsJson,
				(cause) => new StoredSignaturesInvalidError(row.storePathHash, cause)
			).map((signature) => signatureShape(signature))
		}));

		expect({
			signingKeys: persisted.signingKeys,
			narInfoRows,
			blobState: await blobStateNarHashes()
		}).toStrictEqual({
			signingKeys: [{ signing: true, published: true }],
			narInfoRows: [
				{
					cache: defaultCache(),
					storePathHash: metadata.storePathHash,
					signatures: [{ keyName: 'cupboard-v1-1', rawBytes: 64 }]
				}
			],
			blobState: [{ narHash: metadata.narHash }]
		});
	});

	it('serves the same pubkey and accepts a later token through a new stub', async () => {
		await useTestServer('durability-reads');
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await pushPath(init.token, metadata);

		const pubkeyResponse = await testServerFor('durability-reads').fetch(
			new URL('/pubkey', currentOrigin())
		);
		const pubkey = await pubkeyResponse.text();

		const second = await bootstrap();
		const stats = await authorisedFetch(defaultCacheStatsPath, second.token);

		const stored = await readStoredNarInfo(metadata.storePathHash);
		const isCommittedVerified = await isNarInfoSignatureValid(
			NarInfo.parse(stored.body),
			init.publicKey
		);

		expect({
			pubkeyMatches: pubkey === `${init.publicKey}\n`,
			secondTokenAccepted: stats.ok,
			committedVerifies: isCommittedVerified
		}).toStrictEqual({
			pubkeyMatches: true,
			secondTokenAccepted: true,
			committedVerifies: true
		});
	});
});
