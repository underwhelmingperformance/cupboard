import {
	DEFAULT_CACHE,
	nixSha256HashSchema,
	rootNameSchema,
	type StoredCache,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import {
	rootEnsureBodySchema,
	rootSetBodySchema,
	rootSetMaxTargets
} from '@cupboard/protocol/retention';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	commitPath,
	currentNarObjectKey,
	currentServer,
	flakyR2,
	initialise,
	narBytes,
	resetTestServer,
	syntheticNarHash,
	uploadMetadata
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { CacheAdminService } from './cache-admin-service.ts';
import { ServerContext } from './context.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { RetentionService } from './retention-service.ts';
import { RootsService } from './roots-service.ts';
import { type CupboardServer } from './server.ts';

const rootName = rootNameSchema.parse('main');
const defaultCache: StoredCache = DEFAULT_CACHE;
const nixBase32Alphabet = '0123456789abcdfghijklmnpqrsvwxyz';

function indexedStorePathHash(index: number) {
	let remaining = index;
	let encoded = '';

	do {
		encoded =
			nixBase32Alphabet.charAt(remaining % nixBase32Alphabet.length) + encoded;
		remaining = Math.floor(remaining / nixBase32Alphabet.length);
	} while (remaining > 0);

	return storePathHashSchema.parse(encoded.padStart(32, '0'));
}

function trackR2Puts(inner: R2Bucket): {
	readonly bucket: R2Bucket;
	readonly maximum: () => number;
} {
	let active = 0;
	let maximum = 0;
	const bucket: R2Bucket = {
		head: inner.head.bind(inner),
		get: inner.get.bind(inner),
		async put(key, value, options) {
			active += 1;
			maximum = Math.max(maximum, active);

			try {
				return await inner.put(key, value, options);
			} finally {
				active -= 1;
			}
		},
		delete: inner.delete.bind(inner),
		list: inner.list.bind(inner),
		createMultipartUpload: inner.createMultipartUpload.bind(inner),
		resumeMultipartUpload: inner.resumeMultipartUpload.bind(inner)
	};

	return { bucket, maximum: () => maximum };
}

// The first R2 head follows the off-gate identity snapshot and precedes the
// gated revalidation. Run the mutation there to reproduce a row change between
// those two reads.
function rootsServiceWithHeadHook(
	instance: CupboardServer,
	state: DurableObjectState,
	onHead: () => void
): RootsService {
	const context = new ServerContext(state, {
		...instance.context.env,
		BLOBS: flakyR2(instance.context.env.BLOBS, { failures: 0, onMatch: onHead })
	});
	const attestationCas = new AttestationCasService(context);
	const narInfoObjects = new NarInfoObjectsService(context);
	const attestations = new AttestationsService(
		context,
		attestationCas,
		narInfoObjects
	);
	const deletionQueue = new DeletionQueueService(
		context,
		attestationCas,
		attestations,
		narInfoObjects
	);
	const cacheAdmin = new CacheAdminService(context, deletionQueue);
	const retention = new RetentionService(context);

	return new RootsService(context, cacheAdmin, retention, narInfoObjects);
}

function ignoreHead(): void {
	return;
}

// Mutate only on the first head so later targets follow the normal path.
function onceOnHead(mutate: () => void): () => void {
	let isFired = false;

	return () => {
		if (isFired) {
			return;
		}

		isFired = true;
		mutate();
	};
}

describe('root ensure hardening', () => {
	beforeEach(resetTestServer);

	it('returns build-required when a target is recommitted between the ensure probe and the gate', async () => {
		const token = await initialise();
		const committed = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, committed);

		const response = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const roots = rootsServiceWithHeadHook(
					instance,
					state,
					onceOnHead(() => {
						instance.context.db
							.update(schema.narInfos)
							.set({ narHash: syntheticNarHash(1) })
							.where(eq(schema.narInfos.storePathHash, committed.storePathHash))
							.run();
					})
				);

				return roots.ensureRoot(
					DEFAULT_CACHE,
					rootName,
					rootEnsureBodySchema.parse({ targets: [committed.storePath] })
				);
			}
		);

		expect(response).toStrictEqual({
			status: 'build-required',
			unavailable: [committed.storePath]
		});
	});

	// A crash can leave the narinfo object and `blob_state` row after the
	// canonical NAR disappears. The root is not retained because substitution
	// would return 404 for the NAR.
	it('returns build-required when the canonical NAR object is missing behind a live narinfo object', async () => {
		const token = await initialise();
		const committed = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, committed);

		await env.BLOBS.delete(
			await currentNarObjectKey(nixSha256HashSchema.parse(committed.narHash))
		);

		const response = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const roots = rootsServiceWithHeadHook(instance, state, ignoreHead);

				return roots.ensureRoot(
					DEFAULT_CACHE,
					rootName,
					rootEnsureBodySchema.parse({ targets: [committed.storePath] })
				);
			}
		);

		expect(response).toStrictEqual({
			status: 'build-required',
			unavailable: [committed.storePath]
		});
	});

	// A reference edge for an old generation can remain until the deletion
	// backlog drains. It cannot prove that the current row was committed.
	it('returns build-required when only a stale committed edge backs a rewritten row', async () => {
		const token = await initialise();
		const committed = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, committed);

		const response = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				instance.context.db
					.update(schema.narInfos)
					.set({
						generation: sql`${schema.narInfos.generation} + 1`,
						narHash: syntheticNarHash(3)
					})
					.where(eq(schema.narInfos.storePathHash, committed.storePathHash))
					.run();

				const roots = rootsServiceWithHeadHook(instance, state, ignoreHead);

				return roots.ensureRoot(
					DEFAULT_CACHE,
					rootName,
					rootEnsureBodySchema.parse({ targets: [committed.storePath] })
				);
			}
		);

		expect(response).toStrictEqual({
			status: 'build-required',
			unavailable: [committed.storePath]
		});
	});

	it('repairs a narinfo object that belongs to an older row version', async () => {
		const token = await initialise();
		const committed = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, committed);

		const key = narInfoObjectKey(
			fixtureTenant,
			committed.storePathHash,
			DEFAULT_CACHE
		);
		const current = await env.BLOBS.get(key);

		expect(current).not.toBeNull();

		if (current === null) {
			throw new Error('missing committed narinfo object');
		}

		const currentBody = await current.text();
		await env.BLOBS.put(key, 'stale narinfo', {
			customMetadata: {
				generation: '-1',
				narHash: syntheticNarHash(4)
			}
		});

		const response = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const roots = rootsServiceWithHeadHook(instance, state, ignoreHead);

				return roots.ensureRoot(
					DEFAULT_CACHE,
					rootName,
					rootEnsureBodySchema.parse({ targets: [committed.storePath] })
				);
			}
		);
		const repaired = await env.BLOBS.get(key);
		const narUrl = await currentNarObjectKey(committed.narHash);

		expect({
			status: response.status,
			body: await repaired?.text(),
			customMetadata: repaired?.customMetadata
		}).toStrictEqual({
			status: 'retained',
			body: currentBody,
			customMetadata: {
				generation: '0',
				narHash: committed.narHash,
				narUrl,
				signatureGeneration: '1'
			}
		});
	});

	it('repairs a maximum-root-sized legacy object set with bounded concurrency', async () => {
		const token = await initialise();
		const committed = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, committed);
		const targets = Array.from({ length: rootSetMaxTargets }, (_, offset) => {
			const storePathHash = indexedStorePathHash(offset + 1);

			return {
				storePathHash,
				storePath: storePathSchema.parse(
					`/nix/store/${storePathHash}-legacy-${String(offset + 1)}`
				)
			};
		});
		await mapWithConcurrency(targets, 6, ({ storePathHash }) =>
			env.BLOBS.put(
				narInfoObjectKey(fixtureTenant, storePathHash, DEFAULT_CACHE),
				'legacy narinfo\n'
			)
		);

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const source = instance.context.db
					.select()
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, DEFAULT_CACHE),
							eq(schema.narInfos.storePathHash, committed.storePathHash)
						)
					)
					.get();

				if (source === undefined) {
					throw new Error('missing source narinfo row');
				}

				for (const rows of chunk(targets, 4)) {
					instance.context.db
						.insert(schema.narInfos)
						.values(
							rows.map(({ storePathHash, storePath }) => ({
								...source,
								storePathHash,
								storePath
							}))
						)
						.run();
				}

				for (const references of chunk(targets, 18)) {
					await instance.context.d1
						.insert(d1Schema.blobReference)
						.values(
							references.map(({ storePathHash }) => ({
								tenant: fixtureTenant,
								cache: defaultCache,
								storePathHash,
								generation: source.generation,
								narHash: source.narHash
							}))
						)
						.run();
				}

				const tracked = trackR2Puts(instance.context.env.BLOBS);
				const context = new ServerContext(state, {
					...instance.context.env,
					BLOBS: tracked.bucket
				});
				const service = new NarInfoObjectsService(context);
				const servable = await service.servableStorePathHashes(
					DEFAULT_CACHE,
					targets.map((target) => target.storePathHash)
				);

				return {
					servable: [...servable],
					maximumConcurrentPuts: tracked.maximum()
				};
			}
		);

		expect(result).toStrictEqual({
			servable: targets.map((target) => target.storePathHash),
			maximumConcurrentPuts: 6
		});
	}, 120_000);

	it('still returns retained when the row is rewritten to the same identity between the probe and the gate', async () => {
		const token = await initialise();
		const committed = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, committed);

		const response = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const roots = rootsServiceWithHeadHook(
					instance,
					state,
					onceOnHead(() => {
						instance.context.db
							.update(schema.narInfos)
							.set({ narHash: committed.narHash })
							.where(eq(schema.narInfos.storePathHash, committed.storePathHash))
							.run();
					})
				);

				return roots.ensureRoot(
					DEFAULT_CACHE,
					rootName,
					rootEnsureBodySchema.parse({ targets: [committed.storePath] })
				);
			}
		);

		expect(response.status).toBe('retained');
		expect(
			response.status === 'retained' ? response.root.targets : undefined
		).toStrictEqual([
			{
				storePathHash: committed.storePathHash,
				storePath: committed.storePath,
				present: true
			}
		]);
	});

	// Unlike ensureRoot, setRoot records the requested root even when a target is
	// not yet servable. The rewritten row has no current reference edge, so the
	// result reports that target as absent.
	it('lets setRoot succeed over a target recommitted between its probe and its gate, unlike ensure', async () => {
		const token = await initialise();
		const committed = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, committed);

		const summary = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const roots = rootsServiceWithHeadHook(
					instance,
					state,
					onceOnHead(() => {
						instance.context.db
							.update(schema.narInfos)
							.set({ narHash: syntheticNarHash(2) })
							.where(eq(schema.narInfos.storePathHash, committed.storePathHash))
							.run();
					})
				);

				return roots.setRoot(
					DEFAULT_CACHE,
					rootName,
					rootSetBodySchema.parse({ targets: [committed.storePath] })
				);
			}
		);

		expect(summary.targets).toStrictEqual([
			{
				storePathHash: committed.storePathHash,
				storePath: committed.storePath,
				present: false
			}
		]);
	});
});
