import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	firstCacheGeneration,
	nixSha256HashSchema,
	rootNameSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import {
	subrequestSafetyReserve,
	workersInvocationAllowances
} from '@cupboard/protocol/platform';
import {
	rootEnsureBodySchema,
	rootEnsureResponseSchema,
	rootSetBodySchema,
	rootSetMaxTargets
} from '@cupboard/protocol/retention';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheIdentityColumns, type ResolvedCache } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	commitPath,
	currentNarObjectKey,
	currentServer,
	defaultCache,
	initialise,
	namedCache,
	narBytes,
	resetTestServer,
	resolvedCache,
	syntheticNarHash,
	testBase,
	uploadMetadata
} from '../test-support.ts';

import { CacheRegistrationService } from './cache-registration-service.ts';
import { ServerContext } from './context.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { RetentionService } from './retention-service.ts';
import { RootsService } from './roots-service.ts';
import { CupboardServer } from './server.ts';
import {
	subrequestsAvailable,
	withSubrequestSlice
} from './subrequest-slice.ts';

const rootName = rootNameSchema.parse('main');
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

// The first narinfo GET follows the off-gate identity snapshot and precedes
// gated revalidation. Mutate there, not at the later canonical NAR HEAD.
function rootsServiceWithNarInfoGetHook(
	instance: CupboardServer,
	state: DurableObjectState,
	onGet: () => void
): { readonly roots: RootsService; readonly cache: ResolvedCache } {
	const blobs = instance.context.env.BLOBS;
	const context = new ServerContext(state, {
		...instance.context.env,
		BLOBS: new Proxy(blobs, {
			get(target, property, receiver) {
				if (property === 'get') {
					return (key: string) => {
						if (key.startsWith(`t/${fixtureTenant}/narinfo/`)) {
							onGet();
						}
						return blobs.get(key);
					};
				}
				const value: unknown = Reflect.get(target, property, receiver);
				return value;
			}
		})
	});
	const narInfoObjects = new NarInfoObjectsService(context);
	const retention = new RetentionService(context);

	return {
		roots: new RootsService(
			context,
			new CacheRegistrationService(context),
			retention,
			narInfoObjects
		),
		cache: resolvedCache(context)
	};
}

function ignoreNarInfoGet(): void {
	return;
}

// Mutate only on the first narinfo GET so later targets follow the normal path.
function onceOnNarInfoGet(mutate: () => void): () => void {
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
				const { roots, cache } = rootsServiceWithNarInfoGetHook(
					instance,
					state,
					onceOnNarInfoGet(() => {
						instance.context.db
							.update(schema.narInfos)
							.set({ narHash: syntheticNarHash(1) })
							.where(eq(schema.narInfos.storePathHash, committed.storePathHash))
							.run();
					})
				);

				return roots.ensureRoot(
					cache.scope,
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
				const { roots, cache } = rootsServiceWithNarInfoGetHook(
					instance,
					state,
					ignoreNarInfoGet
				);

				return roots.ensureRoot(
					cache.scope,
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

				const { roots, cache } = rootsServiceWithNarInfoGetHook(
					instance,
					state,
					ignoreNarInfoGet
				);

				return roots.ensureRoot(
					cache.scope,
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
			defaultCache()
		);
		const current = await env.BLOBS.get(key);

		expect(current).not.toBeNull();

		if (current === null) {
			throw new Error('missing committed narinfo object');
		}

		const currentBody = await current.text();
		const staleNarHash = syntheticNarHash(4);
		const staleNarInfo = NarInfo.fromFields({
			...NarInfo.parse(currentBody).toFields(),
			narHash: staleNarHash,
			url: narObjectKey(staleNarHash, 2)
		});
		await env.BLOBS.put(key, staleNarInfo.render(), {
			customMetadata: {
				generation: '-1',
				narHash: staleNarHash,
				narUrl: staleNarInfo.url,
				signatureGeneration: '1'
			}
		});

		const response = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const { roots, cache } = rootsServiceWithNarInfoGetHook(
					instance,
					state,
					ignoreNarInfoGet
				);

				return roots.ensureRoot(
					cache.scope,
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
		const published = await env.BLOBS.get(
			narInfoObjectKey(fixtureTenant, committed.storePathHash, defaultCache())
		);
		if (published === null) {
			throw new Error('missing source narinfo object');
		}
		const sourceFields = NarInfo.parse(await published.text()).toFields();
		const targets = Array.from({ length: rootSetMaxTargets }, (_, offset) => {
			const storePathHash = indexedStorePathHash(offset + 1);
			const narHash = syntheticNarHash(offset + 10_000);
			const storePath = storePathSchema.parse(
				`/nix/store/${storePathHash}-legacy-${String(offset + 1)}`
			);
			return {
				narHash,
				storePathHash,
				storePath,
				narinfo: NarInfo.fromFields({
					...sourceFields,
					narHash,
					storePath,
					url: narObjectKey(narHash, 2)
				}).render()
			};
		});
		await mapWithConcurrency(
			targets,
			6,
			async ({ narHash, storePathHash, narinfo }) => {
				await env.BLOBS.put(narObjectKey(narHash, 2), narBytes);
				await env.BLOBS.put(
					narInfoObjectKey(fixtureTenant, storePathHash, defaultCache()),
					narinfo
				);
			}
		);

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const cache = resolvedCache(instance.context);
				const source = instance.context.db
					.select()
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							eq(schema.narInfos.storePathHash, committed.storePathHash)
						)
					)
					.get();

				if (source === undefined) {
					throw new Error('missing source narinfo row');
				}
				const database = drizzleD1(instance.context.env.CUPBOARD_DB, {
					schema: {
						blobReference: d1Schema.blobReference,
						blobState: d1Schema.blobState
					}
				});

				const sourceBlob = await database
					.select()
					.from(d1Schema.blobState)
					.where(eq(d1Schema.blobState.narHash, committed.narHash))
					.get();

				if (sourceBlob === undefined) {
					throw new Error('missing source blob row');
				}

				for (const rows of chunk(targets, 10)) {
					await database
						.insert(d1Schema.blobState)
						.values(rows.map(({ narHash }) => ({ ...sourceBlob, narHash })))
						.run();
				}

				for (const rows of chunk(targets, 4)) {
					instance.context.db
						.insert(schema.narInfos)
						.values(
							rows.map(({ narHash, storePathHash, storePath }) => ({
								...source,
								narHash,
								storePathHash,
								storePath
							}))
						)
						.run();
				}

				for (const references of chunk(targets, 14)) {
					await database
						.insert(d1Schema.blobReference)
						.values(
							references.map(({ narHash, storePathHash }) => ({
								tenant: fixtureTenant,
								...cacheIdentityColumns(cache.scope),
								storePathHash,
								generation: source.generation,
								narHash,
								cacheGeneration: firstCacheGeneration
							}))
						)
						.run();
				}

				const tracked = trackR2Puts(env.BLOBS);
				const restarted = new CupboardServer(state, {
					...instance.context.env,
					BLOBS: tracked.bucket,
					CUPBOARD_DB: env.CUPBOARD_DB,
					CUPBOARD_SUBREQUESTS_PER_INVOCATION: String(
						workersInvocationAllowances.free.subrequests
					)
				});
				vi.useFakeTimers();
				vi.setSystemTime(testBase);

				try {
					const ensure = () =>
						withSubrequestSlice(
							async () => {
								const availableBefore = subrequestsAvailable();
								const request = new Request(
									'https://cupboard.test/roots/main/ensure',
									{
										body: JSON.stringify({
											targets: targets.map((target) => target.storePath),
											retention: { kind: 'duration', seconds: 3600 }
										}),
										headers: {
											authorization: `Bearer ${token}`,
											'content-type': 'application/json'
										},
										method: 'POST'
									}
								);
								const response = await restarted.fetch(request);

								return {
									calls: availableBefore - subrequestsAvailable(),
									httpStatus: response.status,
									body: rootEnsureResponseSchema.parse(await response.json())
								};
							},
							{
								subrequests: workersInvocationAllowances.free.subrequests,
								reserve: subrequestSafetyReserve
							}
						);
					const cold = await ensure();

					await mapWithConcurrency(targets, 6, ({ storePathHash, narinfo }) =>
						env.BLOBS.put(
							narInfoObjectKey(fixtureTenant, storePathHash, defaultCache()),
							narinfo
						)
					);

					return {
						cold,
						warm: await ensure(),
						maximumConcurrentPuts: tracked.maximum()
					};
				} finally {
					vi.useRealTimers();
				}
			}
		);

		const expectedBody = {
			status: 'retained' as const,
			root: {
				name: rootName,
				expiresAt: new Date(testBase.getTime() + 3600 * 1000).toISOString(),
				expired: false,
				createdAt: testBase.toISOString(),
				updatedAt: testBase.toISOString(),
				targets: targets.map(({ storePathHash, storePath }) => ({
					storePathHash,
					storePath,
					present: true
				}))
			}
		};

		expect(result).toStrictEqual({
			cold: { calls: 898, httpStatus: StatusCodes.OK, body: expectedBody },
			warm: { calls: 897, httpStatus: StatusCodes.OK, body: expectedBody },
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
				const { roots, cache } = rootsServiceWithNarInfoGetHook(
					instance,
					state,
					onceOnNarInfoGet(() => {
						instance.context.db
							.update(schema.narInfos)
							.set({ narHash: committed.narHash })
							.where(eq(schema.narInfos.storePathHash, committed.storePathHash))
							.run();
					})
				);

				return roots.ensureRoot(
					cache.scope,
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
				const { roots, cache } = rootsServiceWithNarInfoGetHook(
					instance,
					state,
					onceOnNarInfoGet(() => {
						instance.context.db
							.update(schema.narInfos)
							.set({ narHash: syntheticNarHash(2) })
							.where(eq(schema.narInfos.storePathHash, committed.storePathHash))
							.run();
					})
				);

				return roots.setRoot(
					cache.scope,
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

	// A root write on a cache the tenant does not hold creates the cache, as a
	// push does, so a workflow that ensures a root before its first push needs
	// no registration step.
	it('creates a missing named cache on ensure', async () => {
		const token = await initialise();
		const committed = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, committed);
		const cache = namedCache('pr-7');

		const outcome = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const { roots } = rootsServiceWithNarInfoGetHook(
					instance,
					state,
					ignoreNarInfoGet
				);
				// The path was committed to the default cache, so the new cache cannot
				// serve it; the cache exists all the same.
				const response = await roots.ensureRoot(
					cache,
					rootName,
					rootEnsureBodySchema.parse({ targets: [committed.storePath] })
				);

				return {
					response,
					created: instance.context.cacheRepository.resolve(cache)
				};
			}
		);

		expect(outcome).toStrictEqual({
			response: {
				status: 'build-required',
				unavailable: [committed.storePath]
			},
			created: {
				id: 2,
				scope: cache,
				access: 'public',
				generation: firstCacheGeneration
			}
		});
	});
});
