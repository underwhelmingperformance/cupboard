import { ORPCError } from '@orpc/client';
import { ValidationError } from '@orpc/contract';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CliAbortError, CupboardHttpError } from '../errors.ts';

import type { TokenProvider } from './credentials.ts';
import { controlRpc, tenantRpc } from './orpc.ts';
import { parseWorkerUrl } from './transport.ts';

interface CapturedRequest {
	readonly url: string;
	readonly authorization: string | null;
}

function capturingFetcher(responses: (() => Response)[]): {
	readonly fetcher: typeof fetch;
	readonly captured: CapturedRequest[];
} {
	const captured: CapturedRequest[] = [];

	return {
		captured,
		fetcher: (input, init) => {
			const request = new Request(input, init);
			captured.push({
				url: request.url,
				authorization: request.headers.get('authorization')
			});

			const next = z
				.custom<() => Response>((value) => typeof value === 'function')
				.parse(responses.shift());

			return Promise.resolve(next());
		}
	};
}

async function rejectedBy(run: () => Promise<unknown>): Promise<unknown> {
	let rejected: unknown;

	try {
		await run();
	} catch (error) {
		rejected = error;
	}

	return rejected;
}

const internalError = (): Response =>
	Response.json(
		{
			defined: false,
			code: 'INTERNAL_SERVER_ERROR',
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			message: 'Internal server error',
			data: undefined
		},
		{
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			headers: { 'cf-ray': 'a113b23c78faf6c2' }
		}
	);

// A raw gateway failure from the edge, not a Worker oRPC envelope: transient, so
// it is retried, and its body is surfaced verbatim.
const badGateway = (): Response =>
	new Response('Bad gateway\n', {
		status: StatusCodes.BAD_GATEWAY,
		headers: { 'cf-ray': 'a113b23c78faf6c2' }
	});

describe('tenantRpc', () => {
	it('keeps the tenant path prefix and sends the bound credential', async () => {
		const { fetcher, captured } = capturingFetcher([
			() => Response.json({ caches: [] })
		]);
		const rpc = tenantRpc(parseWorkerUrl('https://cupboard.test/t/acme'), {
			credential: 'admin-token',
			fetcher
		});

		const listed = await rpc.caches.list();

		expect({ listed, captured }).toStrictEqual({
			listed: { caches: [] },
			captured: [
				{
					url: 'https://cupboard.test/t/acme/caches',
					authorization: 'Bearer admin-token'
				}
			]
		});
	});

	it('removes redundant trailing slashes from the tenant base', async () => {
		const { fetcher, captured } = capturingFetcher([
			() => Response.json({ caches: [] })
		]);
		const rpc = tenantRpc(parseWorkerUrl('https://cupboard.test/t/acme///'), {
			fetcher
		});

		await rpc.caches.list();

		expect(captured.map((request) => request.url)).toStrictEqual([
			'https://cupboard.test/t/acme/caches'
		]);
	});

	it('aborts before fetching when the signal is already aborted', async () => {
		const { fetcher, captured } = capturingFetcher([]);
		const controller = new AbortController();
		controller.abort(new CliAbortError());
		const rpc = tenantRpc(parseWorkerUrl('https://cupboard.test'), {
			credential: 'admin-token',
			signal: controller.signal,
			fetcher
		});

		await expect(rpc.caches.list()).rejects.toBeInstanceOf(CliAbortError);
		expect(captured).toStrictEqual([]);
	});

	it('refreshes a provider credential once on a 401 and retries', async () => {
		const provider: TokenProvider = {
			get: () => Promise.resolve('stale-token'),
			refresh: () => Promise.resolve('fresh-token')
		};
		const { fetcher, captured } = capturingFetcher([
			() => new Response('Unauthorised\n', { status: 401 }),
			() => Response.json({ caches: [] })
		]);
		const rpc = tenantRpc(parseWorkerUrl('https://cupboard.test'), {
			credential: provider,
			fetcher
		});

		const listed = await rpc.caches.list();

		expect({
			listed,
			authorisations: captured.map((request) => request.authorization)
		}).toStrictEqual({
			listed: { caches: [] },
			authorisations: ['Bearer stale-token', 'Bearer fresh-token']
		});
	});

	it('does not retry a fixed string token on 401', async () => {
		const { fetcher, captured } = capturingFetcher([
			() => new Response('Unauthorised\n', { status: 401 })
		]);
		const rpc = tenantRpc(parseWorkerUrl('https://cupboard.test'), {
			credential: 'static-token',
			fetcher
		});

		const rejected = await rejectedBy(() => rpc.caches.list());

		expect(rejected).toBeInstanceOf(ORPCError);

		if (rejected instanceof ORPCError) {
			expect(rejected).toMatchObject({
				defined: true,
				code: 'UNAUTHORIZED',
				status: 401,
				data: {
					body: 'Unauthorised\n',
					headers: { 'content-type': 'text/plain;charset=UTF-8' },
					status: 401
				}
			});
		}

		expect(captured.map((request) => request.authorization)).toStrictEqual([
			'Bearer static-token'
		]);
	});

	it('retries a transient gateway failure and returns the eventual success', async () => {
		vi.useFakeTimers();

		try {
			const { fetcher, captured } = capturingFetcher([
				badGateway,
				badGateway,
				() => Response.json({ caches: [] })
			]);
			const rpc = tenantRpc(parseWorkerUrl('https://cupboard.test/t/acme'), {
				credential: 'admin-token',
				fetcher
			});

			const pending = rpc.caches.list();
			await vi.advanceTimersByTimeAsync(60_000);

			expect({
				listed: await pending,
				attempts: captured.length
			}).toStrictEqual({ listed: { caches: [] }, attempts: 3 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('surfaces the ray id once the retry budget is spent', async () => {
		vi.useFakeTimers();

		try {
			// One attempt plus the four retries: every one fails, so the error
			// surfaces after the final attempt.
			const { fetcher, captured } = capturingFetcher(
				Array.from({ length: 5 }, () => badGateway)
			);
			const rpc = tenantRpc(parseWorkerUrl('https://cupboard.test/t/acme'), {
				credential: 'admin-token',
				fetcher
			});

			const pending = rejectedBy(() => rpc.caches.list());
			await vi.advanceTimersByTimeAsync(60_000);
			const rejected = await pending;

			expect(rejected).toBeInstanceOf(CupboardHttpError);
			expect(captured.length).toBe(5);

			if (rejected instanceof CupboardHttpError) {
				expect({
					method: rejected.method,
					path: rejected.path,
					status: rejected.status,
					body: rejected.body,
					ray: rejected.ray
				}).toStrictEqual({
					method: 'GET',
					path: '/t/acme/caches',
					status: StatusCodes.BAD_GATEWAY,
					body: 'Bad gateway',
					ray: 'a113b23c78faf6c2'
				});
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not retry a 500, surfacing its decoded message at once', async () => {
		const { fetcher, captured } = capturingFetcher([internalError]);
		const rpc = tenantRpc(parseWorkerUrl('https://cupboard.test/t/acme'), {
			credential: 'admin-token',
			fetcher
		});

		const rejected = await rejectedBy(() => rpc.caches.list());

		expect(rejected).toBeInstanceOf(CupboardHttpError);
		expect(captured.length).toBe(1);

		if (rejected instanceof CupboardHttpError) {
			expect({
				method: rejected.method,
				path: rejected.path,
				status: rejected.status,
				body: rejected.body,
				ray: rejected.ray
			}).toStrictEqual({
				method: 'GET',
				path: '/t/acme/caches',
				status: StatusCodes.INTERNAL_SERVER_ERROR,
				body: 'Internal server error',
				ray: 'a113b23c78faf6c2'
			});
		}
	});

	it('leaves a mapped 5xx for the contract to decode', async () => {
		const { fetcher } = capturingFetcher([
			() =>
				Response.json(
					{
						defined: false,
						code: 'INSUFFICIENT_STORAGE',
						status: StatusCodes.INSUFFICIENT_STORAGE,
						message: 'Cache is over quota',
						data: undefined
					},
					{
						status: StatusCodes.INSUFFICIENT_STORAGE,
						headers: { 'cf-ray': 'b224c34d89fbf7d3' }
					}
				)
		]);
		const rpc = tenantRpc(parseWorkerUrl('https://cupboard.test/t/acme'), {
			credential: 'admin-token',
			fetcher
		});

		const rejected = await rejectedBy(() => rpc.caches.list());

		expect(rejected).toBeInstanceOf(ORPCError);

		if (rejected instanceof ORPCError) {
			expect(rejected).toMatchObject({
				code: 'INSUFFICIENT_STORAGE',
				status: StatusCodes.INSUFFICIENT_STORAGE
			});
		}
	});

	it('rejects a response that does not satisfy the contract', async () => {
		const { fetcher } = capturingFetcher([
			() => Response.json({ caches: [{ name: 'builds' }] })
		]);
		const rpc = tenantRpc(parseWorkerUrl('https://cupboard.test'), {
			credential: 'admin-token',
			fetcher
		});

		const rejected = await rejectedBy(() => rpc.caches.list());

		expect(rejected).toBeInstanceOf(ValidationError);

		if (rejected instanceof ValidationError) {
			expect({
				data: rejected.data,
				issuePaths: rejected.issues.map((issue) => issue.path)
			}).toStrictEqual({
				data: { caches: [{ name: 'builds' }] },
				issuePaths: [
					['caches', 0, 'priority'],
					['caches', 0, 'storePaths']
				]
			});
		}
	});
});

describe('controlRpc', () => {
	it('addresses the contract under the /control prefix', async () => {
		const { fetcher, captured } = capturingFetcher([
			() => Response.json({ tenants: [] })
		]);
		const rpc = controlRpc(parseWorkerUrl('https://cupboard.test'), {
			credential: 'admin-token',
			fetcher
		});

		const listed = await rpc.tenants.list();

		expect({ listed, captured }).toStrictEqual({
			listed: { tenants: [] },
			captured: [
				{
					url: 'https://cupboard.test/control/tenants',
					authorization: 'Bearer admin-token'
				}
			]
		});
	});

	it('removes redundant trailing slashes before the control prefix', async () => {
		const { fetcher, captured } = capturingFetcher([
			() => Response.json({ tenants: [] })
		]);
		const rpc = controlRpc(parseWorkerUrl('https://cupboard.test///'), {
			fetcher
		});

		await rpc.tenants.list();

		expect(captured.map((request) => request.url)).toStrictEqual([
			'https://cupboard.test/control/tenants'
		]);
	});
});
