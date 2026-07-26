import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { cacheAvailabilityResponseSchema } from '@cupboard/protocol/cache-availability';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	bootstrap,
	handlerFetch,
	narBytes,
	provisionFixtureTenant,
	pushPath,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

const missingStorePathHash = storePathHashSchema.parse('2'.repeat(32));

describe('cache availability query', () => {
	beforeEach(resetTestServer);

	it.each([
		{ name: 'the default cache', cache: undefined, path: '' },
		{ name: 'a named cache', cache: 'builds', path: '/cache/builds' }
	])(
		'returns missing hashes for $name in one response',
		async ({ cache, path }) => {
			const init = await bootstrap();
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

	it('uses the cache read credential for a private tenant', async () => {
		await bootstrap();
		await provisionFixtureTenant({
			readMode: 'private',
			read: { user: 'alice', password: 'secret' }
		});
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
});
