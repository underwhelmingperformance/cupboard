import { tenantContract } from '@cupboard/protocol/contract';
import { createORPCClient, isDefinedError, safe } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	bootstrap,
	currentOrigin,
	currentServer,
	mintServerSignedToken,
	narBytes,
	pushPath,
	resetTestServer,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

type TenantClient = JsonifiedClient<
	ContractRouterClient<typeof tenantContract>
>;

// The real derived client, exactly as the CLI builds it: the OpenAPI link over
// the contract, with responses validated against the contract's output
// schemas. Requests reach the Durable Object the harness targets, so the lock
// covers the mounted handler, the middleware chain and the services.
function tenantClient(token: string): TenantClient {
	const link = new OpenAPILink(tenantContract, {
		url: currentOrigin(),
		headers: { authorization: `Bearer ${token}` },
		fetch: (request) => currentServer().fetch(request),
		plugins: [new ResponseValidationPlugin(tenantContract)]
	});

	return createORPCClient(link);
}

describe('tenant contract round trip', () => {
	beforeEach(resetTestServer);

	it('drives the cache registry through the derived client', async () => {
		await useTestServer('contract-caches');
		const init = await bootstrap();
		const client = tenantClient(init.token);

		const created = await client.caches.put({
			cacheName: 'builds',
			priority: 30
		});
		const listed = await client.caches.list();
		const removed = await client.caches.remove({
			params: { cacheName: 'builds' }
		});

		expect({ created, listed, removed }).toStrictEqual({
			created: { name: 'builds', priority: 30, storePaths: 0 },
			listed: {
				caches: [
					{ name: '', priority: 40, storePaths: 0 },
					{ name: 'builds', priority: 30, storePaths: 0 }
				]
			},
			removed: { name: 'builds', removed: true, storePathsRemoved: 0 }
		});
	});

	it('answers a refused teardown as the defined CACHE_NOT_EMPTY error', async () => {
		await useTestServer('contract-cache-not-empty');
		const init = await bootstrap();
		const client = tenantClient(init.token);
		await pushPath(
			init.token,
			uploadMetadata({ fileSize: narBytes.byteLength }),
			'builds'
		);

		const [error, data, isDefined] = await safe(
			client.caches.remove({ params: { cacheName: 'builds' } })
		);
		const forced = await client.caches.remove({
			params: { cacheName: 'builds' },
			query: { force: true }
		});

		if (!isDefinedError(error)) {
			throw new Error('expected a defined contract error');
		}

		expect({
			isDefined,
			data,
			code: error.code,
			status: error.status,
			errorData: error.data,
			forced
		}).toStrictEqual({
			isDefined: true,
			data: undefined,
			code: 'CACHE_NOT_EMPTY',
			status: StatusCodes.CONFLICT,
			errorData: { cache: 'builds' },
			forced: { name: 'builds', removed: true, storePathsRemoved: 1 }
		});
	});

	it('refuses a write-scoped token on an admin procedure', async () => {
		await useTestServer('contract-scope');
		await bootstrap();
		const client = tenantClient(await mintServerSignedToken('write'));

		const [error, data, isDefined] = await safe(client.caches.list());

		if (!isDefinedError(error)) {
			throw new Error('expected a defined contract error');
		}

		expect({
			isDefined,
			data,
			code: error.code,
			status: error.status
		}).toStrictEqual({
			isDefined: true,
			data: undefined,
			code: 'FORBIDDEN',
			status: StatusCodes.FORBIDDEN
		});
	});
});
