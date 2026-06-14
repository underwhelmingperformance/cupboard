import { ORPCError } from '@orpc/client';
import { ValidationError } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CliAbortError } from '../errors.ts';

import type { TokenProvider } from './credentials.ts';
import { controlRpc, tenantRpc } from './orpc.ts';

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

describe('tenantRpc', () => {
	it('keeps the tenant path prefix and sends the bound credential', async () => {
		const { fetcher, captured } = capturingFetcher([
			() => Response.json({ caches: [] })
		]);
		const rpc = tenantRpc('https://cupboard.test/t/acme', {
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

	it('aborts before fetching when the signal is already aborted', async () => {
		const { fetcher, captured } = capturingFetcher([]);
		const controller = new AbortController();
		controller.abort(new CliAbortError());
		const rpc = tenantRpc('https://cupboard.test', {
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
		const rpc = tenantRpc('https://cupboard.test', {
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
		const rpc = tenantRpc('https://cupboard.test', {
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

	it('rejects a response that does not satisfy the contract', async () => {
		const { fetcher } = capturingFetcher([
			() => Response.json({ caches: [{ name: 'builds' }] })
		]);
		const rpc = tenantRpc('https://cupboard.test', {
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
		const rpc = controlRpc('https://cupboard.test', {
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
});
