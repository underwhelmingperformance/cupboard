import { startCapture } from '@cupboard/logger/testing';
import {
	type CacheScope,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	cacheAvailabilityMaxPaths,
	cacheAvailabilityResponseSchema
} from '@cupboard/protocol/cache-availability';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { withSubrequestSlice } from '../do/subrequest-slice.ts';
import { SubrequestSliceExceededError } from '../errors.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	asOneInvocation,
	bootstrap,
	currentServer,
	defaultCache,
	handlerFetch,
	namedCache,
	narBytes,
	provisionFixtureTenant,
	pushPath,
	putTestCache,
	recordTransition,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

import { missingStorePathHashes } from './read.ts';

const missingStorePathHash = storePathHashSchema.parse('2'.repeat(32));
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

	it("requires the tenant's Basic credentials when reads are private", async () => {
		await recordTransition('cache-identity', 'complete');
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
			objectRequests: 2
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
		}).toStrictEqual({ isRefused: true, subrequests: 2 });
	});
});
