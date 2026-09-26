import { startCapture } from '@cupboard/logger/testing';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type CacheScope,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	cacheAvailabilityMaxPaths,
	cacheAvailabilityResponseSchema
} from '@cupboard/protocol/cache-availability';
import { type UploadPathMetadata } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { promoteVerifiedBlob } from '../blob/promote-blob.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { NarInfoObjectsService } from '../do/narinfo-objects-service.ts';
import { withSubrequestSlice } from '../do/subrequest-slice.ts';
import { SubrequestSliceExceededError } from '../errors.ts';
import { narInfoCacheTag } from '../http/cache-tags.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	asOneInvocation,
	bootstrap,
	currentNarObjectKey,
	currentServer,
	defaultCache,
	handlerFetch,
	namedCache,
	narBytes,
	provisionFixtureTenant,
	pushPath,
	putTestCache,
	readFetch,
	recordDeploymentPhase,
	resetTestServer,
	resolvedCache,
	testServerFor,
	uploadMetadata
} from '../test-support.ts';

import { missingStorePathHashes } from './read.ts';

const missingStorePathHash = storePathHashSchema.parse('2'.repeat(32));
const sharedCache = namedCache('other');
const otherMissingStorePathHash = storePathHashSchema.parse('3'.repeat(32));

const requestFinishedSchema = z.object({ path: z.string() });

// Counts the requests the tenant Durable Object answered at `path` while
// `run` ran. The object logs one `request finished` line per request; the
// Worker logs none.
async function objectRequestsAt<T>(
	path: string,
	run: () => Promise<T>
): Promise<{ result: T; objectRequests: number }> {
	const capture = startCapture();
	let result: T;

	try {
		result = await run();
	} finally {
		capture.stop();
	}

	return {
		result,
		objectRequests: capture.logs.filter(
			(entry) =>
				entry.message === 'request finished' &&
				requestFinishedSchema.parse(entry.properties).path === path
		).length
	};
}

describe('cache availability query', () => {
	beforeEach(resetTestServer);

	it.each<{
		name: string;
		cache: CacheScope;
		path: string;
	}>([
		{ name: 'the default cache', cache: defaultCache(), path: '' },
		{
			name: 'a named cache',
			cache: namedCache('builds'),
			path: '/cache/builds'
		}
	])(
		'reports only absent store-path hashes for $name',
		async ({ cache, path }) => {
			const init = await bootstrap({
				caches: cache.kind === 'named' ? [{ scope: cache }] : []
			});
			const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
			await pushPath(init.token, metadata, cache);

			const response = await handlerFetch(
				`/t/${fixtureTenant}${path}/api/v1/missing-paths`,
				{
					body: JSON.stringify({
						storePathHashes: [metadata.storePathHash, missingStorePathHash]
					}),
					headers: { 'content-type': 'application/json' },
					method: 'POST'
				}
			);
			const body = cacheAvailabilityResponseSchema.parse(await response.json());

			expect({
				status: response.status,
				cacheControl: response.headers.get('cache-control'),
				body
			}).toStrictEqual({
				status: StatusCodes.OK,
				cacheControl: 'no-store',
				body: { missingStorePathHashes: [missingStorePathHash] }
			});
		}
	);

	it('reports a published path as missing when its NAR object is gone', async () => {
		const { token } = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(token, metadata, defaultCache());
		const published = await readFetch(`/${metadata.storePathHash}.narinfo`);
		const key = await currentNarObjectKey(metadata.narHash);
		await env.BLOBS.delete(key);
		const purge = await runInDurableObject(
			testServerFor(fixtureTenant),
			(instance) =>
				vi
					.spyOn(instance.context, 'purgeCacheTags')
					.mockResolvedValue(undefined)
		);

		try {
			const response = await handlerFetch(
				`/t/${fixtureTenant}/api/v1/missing-paths`,
				{
					body: JSON.stringify({ storePathHashes: [metadata.storePathHash] }),
					headers: { 'content-type': 'application/json' },
					method: 'POST'
				}
			);
			const narInfo = await readFetch(`/${metadata.storePathHash}.narinfo`);

			expect({
				status: response.status,
				body: await response.json(),
				purged: purge.mock.calls,
				cacheTag: published.headers.get('cache-tag'),
				narInfo: narInfo.status
			}).toStrictEqual({
				status: StatusCodes.OK,
				body: { missingStorePathHashes: [metadata.storePathHash] },
				purged: [],
				cacheTag: narInfoCacheTag(
					fixtureTenant,
					defaultCache(),
					metadata.storePathHash
				),
				narInfo: StatusCodes.OK
			});
		} finally {
			purge.mockRestore();
		}
	});

	it('reports a path as present when its blob has no registry row', async () => {
		const { token } = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(token, metadata, defaultCache());
		await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.delete(d1Schema.objectIncarnation)
			.where(eq(d1Schema.objectIncarnation.objectId, metadata.narHash));

		const response = await handlerFetch(
			`/t/${fixtureTenant}/api/v1/missing-paths`,
			{
				body: JSON.stringify({ storePathHashes: [metadata.storePathHash] }),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			}
		);

		expect({
			status: response.status,
			body: cacheAvailabilityResponseSchema.parse(await response.json())
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: { missingStorePathHashes: [] }
		});
	});

	it.each([
		{
			repair: 'a later publication',
			repairPath: async (token: string, metadata: UploadPathMetadata) => {
				await pushPath(token, metadata, sharedCache);
				// The negotiation queues reconciliation, which the alarm runs.
				await runInDurableObject(currentServer(), (instance) =>
					instance.alarm()
				);
			}
		},
		{
			repair: 'a servability check',
			repairPath: async (_token: string, metadata: UploadPathMetadata) => {
				await runInDurableObject(currentServer(), (instance) =>
					new NarInfoObjectsService(instance.context).servableNarInfoVersions(
						resolvedCache(instance.context, sharedCache),
						[metadata.storePathHash]
					)
				);
			}
		}
	])(
		"repairs another cache's narinfo through $repair after a shared NAR is recovered",
		async ({ repairPath }) => {
			const { token } = await bootstrap({ caches: [{ scope: sharedCache }] });
			const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
			await pushPath(token, metadata, defaultCache());
			await pushPath(token, metadata, sharedCache);
			const oldKey = await currentNarObjectKey(metadata.narHash);
			await env.BLOBS.delete(oldKey);
			const stagingKey = r2ObjectKeySchema.parse(
				'staging/recover-shared/upload'
			);
			await env.BLOBS.put(stagingKey, narBytes);
			await promoteVerifiedBlob(
				drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
				env.BLOBS,
				stagingKey,
				{ narHash: metadata.narHash, narSize: metadata.narSize },
				{ fileHash: metadata.fileHash, fileSize: metadata.fileSize }
			);
			const probe = async () => {
				const response = await handlerFetch(
					`/t/${fixtureTenant}/cache/${sharedCache.name}/api/v1/missing-paths`,
					{
						body: JSON.stringify({
							storePathHashes: [metadata.storePathHash]
						}),
						headers: { 'content-type': 'application/json' },
						method: 'POST'
					}
				);

				return cacheAvailabilityResponseSchema.parse(await response.json());
			};
			const advertisedNar = async () => {
				const narInfo = await readFetch(
					`/cache/${sharedCache.name}/${metadata.storePathHash}.narinfo`
				);
				const nar = await readFetch(
					`/cache/${sharedCache.name}/${NarInfo.parse(await narInfo.text()).url}`
				);

				return {
					status: nar.status,
					body: nar.ok ? new Uint8Array(await nar.arrayBuffer()) : undefined
				};
			};

			const beforeRepair = { probe: await probe(), nar: await advertisedNar() };
			const purge = await runInDurableObject(currentServer(), (instance) =>
				vi.spyOn(instance.context, 'purgeCacheTags').mockResolvedValue()
			);

			try {
				await repairPath(token, metadata);
				await runInDurableObject(currentServer(), (instance) =>
					instance.alarm()
				);

				expect({
					replacedIncarnation:
						(await currentNarObjectKey(metadata.narHash)) !== oldKey,
					beforeRepair,
					afterRepair: { probe: await probe(), nar: await advertisedNar() },
					// The scheduler can deliver an alarm while this test runs its own,
					// and each alarm can rewrite the obsolete object and queue its
					// purge. Compare the distinct purged tags.
					purgedTags: [...new Set(purge.mock.calls.flatMap(([tags]) => tags))]
				}).toStrictEqual({
					replacedIncarnation: true,
					beforeRepair: {
						probe: { missingStorePathHashes: [metadata.storePathHash] },
						nar: { status: StatusCodes.NOT_FOUND, body: undefined }
					},
					afterRepair: {
						probe: { missingStorePathHashes: [] },
						nar: { status: StatusCodes.OK, body: narBytes }
					},
					purgedTags: [
						narInfoCacheTag(fixtureTenant, sharedCache, metadata.storePathHash)
					]
				});
			} finally {
				purge.mockRestore();
			}
		}
	);

	it('does not purge a private cache when probing its missing NAR', async () => {
		await recordDeploymentPhase('contracted');
		const { token } = await bootstrap();
		await provisionFixtureTenant({
			read: { user: 'alice', password: 'secret' }
		});
		await putTestCache(token, defaultCache(), 'private');
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(token, metadata);
		await env.BLOBS.delete(await currentNarObjectKey(metadata.narHash));
		const purge = await runInDurableObject(
			testServerFor(fixtureTenant),
			(instance) =>
				vi
					.spyOn(instance.context, 'purgeCacheTags')
					.mockResolvedValue(undefined)
		);

		try {
			const response = await handlerFetch(
				`/t/${fixtureTenant}/api/v1/missing-paths`,
				{
					body: JSON.stringify({ storePathHashes: [metadata.storePathHash] }),
					headers: {
						'content-type': 'application/json',
						authorization: `Basic ${btoa('alice:secret')}`
					},
					method: 'POST'
				}
			);

			expect({
				status: response.status,
				body: await response.json(),
				purged: purge.mock.calls
			}).toStrictEqual({
				status: StatusCodes.OK,
				body: { missingStorePathHashes: [metadata.storePathHash] },
				purged: []
			});
		} finally {
			purge.mockRestore();
		}
	});

	it("requires the tenant's Basic credentials when reads are private", async () => {
		await recordDeploymentPhase('contracted');
		const { token } = await bootstrap();
		await provisionFixtureTenant({
			read: { user: 'alice', password: 'secret' }
		});
		await putTestCache(token, defaultCache(), 'private');
		const request = {
			body: JSON.stringify({ storePathHashes: [missingStorePathHash] }),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		};

		const unauthorised = await handlerFetch(
			`/t/${fixtureTenant}/api/v1/missing-paths`,
			request
		);
		const authorised = await handlerFetch(
			`/t/${fixtureTenant}/api/v1/missing-paths`,
			{
				...request,
				headers: {
					...request.headers,
					authorization: `Basic ${btoa('alice:secret')}`
				}
			}
		);

		expect({
			unauthorised: unauthorised.status,
			authorised: authorised.status
		}).toStrictEqual({
			unauthorised: StatusCodes.UNAUTHORIZED,
			authorised: StatusCodes.OK
		});
	});

	it('answers a full page across Free-sized object requests', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata);
		const missing = Array.from(
			{ length: cacheAvailabilityMaxPaths - 1 },
			(_, index) =>
				storePathHashSchema.parse(String(index + 100).padStart(32, '0'))
		);

		const { result, objectRequests } = await objectRequestsAt(
			'/api/v1/missing-paths',
			async () => {
				const response = await handlerFetch(
					`/t/${fixtureTenant}/api/v1/missing-paths`,
					{
						body: JSON.stringify({
							storePathHashes: [metadata.storePathHash, ...missing]
						}),
						headers: { 'content-type': 'application/json' },
						method: 'POST'
					}
				);

				return {
					status: response.status,
					body: cacheAvailabilityResponseSchema.parse(await response.json())
				};
			}
		);

		expect({ ...result, objectRequests }).toStrictEqual({
			status: StatusCodes.OK,
			body: { missingStorePathHashes: missing },
			objectRequests: 3
		});
	});

	// The Worker sizes a chunk to the object's slice, so a chunk the slice
	// cannot afford is a sizing defect and the object refuses it instead of
	// running into the platform's ceiling.
	it('refuses a chunk whose heads exceed the subrequest slice', async () => {
		await bootstrap();

		let refusal: unknown;

		try {
			await runInDurableObject(currentServer(), (instance) =>
				withSubrequestSlice(
					() =>
						asOneInvocation(() =>
							missingStorePathHashes(
								instance.context.env.BLOBS,
								instance.context.d1,
								fixtureTenant,
								defaultCache(),
								[missingStorePathHash, otherMissingStorePathHash]
							)
						),
					{ subrequests: 1, reserve: 0 }
				)
			);
		} catch (error) {
			refusal = error;
		}

		expect({
			isRefused: refusal instanceof SubrequestSliceExceededError,
			subrequests:
				refusal instanceof SubrequestSliceExceededError
					? refusal.subrequests
					: undefined
		}).toStrictEqual({ isRefused: true, subrequests: 4 });
	});
});
