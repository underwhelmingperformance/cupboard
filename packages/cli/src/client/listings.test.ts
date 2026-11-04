import { collectProgressively } from '@cupboard/shared/collections';
import { probeDeadlineMs } from '@cupboard/shared/timeout';
import { describe, expect, it, vi } from 'vitest';

import {
	destroyAfterHeaders,
	loopbackServer
} from '../../../../tests/support/loopback-server.ts';
import { stalledResponse } from '../../../../tests/support/stalled-request.ts';

import { cachePages, listingLimits } from './listings.ts';
import { type CallOptions, tenantRpc } from './orpc.ts';

const maximumBackoffMs = 5000;

describe('cachePages', () => {
	it('lists every page under a prefix and retries a page that hangs past its deadline', async () => {
		const calls: unknown[] = [];
		const lister = {
			async list(
				input?: { readonly namePrefix?: string; readonly cursor?: string },
				options?: CallOptions
			) {
				calls.push(input);
				if (input?.cursor === undefined) {
					return { caches: ['pr-1'], cursor: 'pr-1' };
				}
				if (calls.length === 2) {
					await stalledResponse(options?.signal);
				}
				return { caches: ['pr-2'] };
			}
		};

		vi.useFakeTimers();
		try {
			const collect = async (): Promise<string[]> =>
				collectProgressively(
					await cachePages(lister, 'pr-'),
					listingLimits('The test listing')
				);
			const pending = collect();
			const settled = expect(pending).resolves.toStrictEqual(['pr-1', 'pr-2']);
			await vi.advanceTimersByTimeAsync(probeDeadlineMs + maximumBackoffMs);
			await settled;
		} finally {
			vi.useRealTimers();
		}

		expect(calls).toStrictEqual([
			{ namePrefix: 'pr-' },
			{ namePrefix: 'pr-', cursor: 'pr-1' },
			{ namePrefix: 'pr-', cursor: 'pr-1' }
		]);
	});

	it('sends a caches.list request again after its response body fails partway', async () => {
		const server = await loopbackServer((_request, response) => {
			if (server.requests.length === 1) {
				destroyAfterHeaders()(response);
				return;
			}
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ caches: [] }));
		});
		const random = vi.spyOn(Math, 'random').mockReturnValue(0);
		try {
			const rpc = tenantRpc(new URL(`${server.origin}/t/acme`), {
				credential: 'token'
			});
			const caches = await collectProgressively(
				await cachePages(rpc.caches, 'pr-'),
				listingLimits('The test listing')
			);
			const listing = {
				method: 'GET',
				url: '/t/acme/caches?namePrefix=pr-',
				authorization: 'Bearer token'
			};

			expect({
				caches,
				requests: server.requests.map((request) => ({
					method: request.method,
					url: request.url,
					authorization: request.headers.authorization
				}))
			}).toStrictEqual({ caches: [], requests: [listing, listing] });
		} finally {
			random.mockRestore();
			await server.close();
		}
	});
});
