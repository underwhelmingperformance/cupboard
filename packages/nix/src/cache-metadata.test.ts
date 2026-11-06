import { storePathSchema } from '@cupboard/nix-store/scalars';
import {
	cacheMetadataCapability,
	cacheMetadataCapabilityHeader
} from '@cupboard/protocol/cache-metadata';
import { describe, expect, it } from 'vitest';

import {
	destroyAfterHeaders,
	loopbackServer
} from '../../../tests/support/loopback-server.ts';

import { CachedClosureReader } from './cache-metadata.ts';

const storePath = storePathSchema.parse(
	'/nix/store/11111111111111111111111111111111-app'
);

describe('CachedClosureReader', () => {
	it.each([
		{ response: 'a metadata page', status: 200 },
		{ response: 'an error response', status: 500 }
	])(
		'sends a metadata request again after the body of $response fails partway',
		async ({ status }) => {
			let pageRequests = 0;
			const server = await loopbackServer((request, response) => {
				if (request.method !== 'POST') {
					response.writeHead(404, {
						[cacheMetadataCapabilityHeader]: cacheMetadataCapability
					});
					response.end();
					return;
				}
				pageRequests += 1;
				if (pageRequests === 1) {
					destroyAfterHeaders(status)(response);
					return;
				}
				response.setHeader('content-type', 'application/json');
				response.end(
					JSON.stringify({
						scopeVersion: 'scope-1',
						entries: [{ storePath, status: 'missing' }]
					})
				);
			});
			try {
				const reader = new CachedClosureReader(
					{ url: new URL(`${server.origin}/t/acme`), paths: [storePath] },
					fetch,
					{ random: () => 0 }
				);

				const offers = await reader.offers([storePath]);
				const page = {
					method: 'POST',
					url: '/t/acme/api/v1/path-info',
					accept: 'application/json',
					contentType: 'application/json',
					body: JSON.stringify({ storePaths: [storePath] })
				};

				expect({
					offers,
					requests: server.requests.map((request) => ({
						method: request.method,
						url: request.url,
						accept: request.headers.accept,
						contentType: request.headers['content-type'],
						body: request.body
					}))
				}).toStrictEqual({
					offers: [undefined],
					requests: [
						{
							method: 'GET',
							url: '/t/acme/11111111111111111111111111111111.narinfo',
							accept: 'text/x-nix-narinfo',
							contentType: undefined,
							body: ''
						},
						page,
						page
					]
				});
			} finally {
				await server.close();
			}
		}
	);
});
