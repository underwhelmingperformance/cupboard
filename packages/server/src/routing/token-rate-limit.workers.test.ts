import { tokenRateLimit } from '@cupboard/protocol/oidc';
import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { TokenRateLimitedError } from '../errors.ts';
import { testControlEnv } from '../test-support.ts';

import worker from './handler.ts';

interface ObservedResponse {
	readonly status: number;
	readonly retryAfter: string | undefined;
	readonly cacheControl: string | undefined;
	readonly body: unknown;
}

interface CountingLimiter {
	readonly limiter: RateLimit;
	readonly keys: readonly string[];
}

// Miniflare's binding counts in windows aligned to the wall clock, so a test
// that spends a budget with it can cross into a new window part way through.
// This limiter allows `budget` requests for each key for the whole test.
function countingLimiter(budget: number): CountingLimiter {
	const keys: string[] = [];

	return {
		keys,
		limiter: {
			limit({ key }) {
				keys.push(key);
				const count = keys.filter((seen) => seen === key).length;

				return Promise.resolve({ success: count <= budget });
			}
		}
	};
}

interface Probe {
	readonly method: 'GET' | 'POST';
	readonly path: string;
	readonly address: string;
}

async function fetchWorker(
	probe: Probe,
	limiter: RateLimit
): Promise<ObservedResponse> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request(new URL(probe.path, 'https://cupboard.test'), {
			method: probe.method,
			headers: {
				'cf-connecting-ip': probe.address,
				...(probe.method === 'POST' && {
					'content-type': 'application/x-www-form-urlencoded'
				})
			},
			...(probe.method === 'POST' && { body: 'grant_type=authorization_code' })
		}),
		{ ...env, ...testControlEnv, TOKEN_RATE_LIMITER: limiter },
		ctx
	);
	await waitOnExecutionContext(ctx);
	const isJson =
		response.headers.get('content-type')?.startsWith('application/json') ??
		false;

	return {
		status: response.status,
		retryAfter: response.headers.get('retry-after') ?? undefined,
		cacheControl: response.headers.get('cache-control') ?? undefined,
		body: isJson ? await response.json() : await response.text()
	};
}

async function statusOf(probe: Probe, limiter: RateLimit): Promise<number> {
	const response = await fetchWorker(probe, limiter);

	return response.status;
}

const budget = 2;
const address = '192.0.2.1';

function post(path: string, from = address): Probe {
	return { method: 'POST', path, address: from };
}

async function spendBudget(
	probe: Probe,
	limiter: RateLimit
): Promise<number[]> {
	const statuses: number[] = [];

	for (let request = 0; request < budget; request += 1) {
		statuses.push(await statusOf(probe, limiter));
	}

	return statuses;
}

describe('token request rate limit', () => {
	it.each([
		{
			name: 'control token requests',
			path: '/token',
			surface: { kind: 'control' },
			status: StatusCodes.BAD_REQUEST
		},
		{
			name: 'signup requests',
			path: '/signup',
			surface: { kind: 'control' },
			status: StatusCodes.BAD_REQUEST
		},
		{
			name: 'control revocation requests',
			path: '/revoke',
			surface: { kind: 'control' },
			status: StatusCodes.BAD_REQUEST
		},
		{
			name: 'tenant token requests',
			path: '/t/acme/token',
			surface: { kind: 'tenant', tenant: 'acme' },
			status: StatusCodes.NOT_FOUND
		},
		{
			name: 'tenant revocation requests',
			path: '/t/acme/revoke',
			surface: { kind: 'tenant', tenant: 'acme' },
			status: StatusCodes.NOT_FOUND
		}
	])(
		'refuses $name from an address that has spent its budget',
		async ({ path, surface, status }) => {
			const { limiter, keys } = countingLimiter(budget);
			const allowed = await spendBudget(post(path), limiter);
			const refused = await fetchWorker(post(path), limiter);

			expect({ allowed, refused, keys }).toStrictEqual({
				allowed: [status, status],
				refused: {
					status: StatusCodes.TOO_MANY_REQUESTS,
					retryAfter: String(tokenRateLimit.periodSeconds),
					cacheControl: 'no-store',
					body: {
						error: 'temporarily_unavailable',
						error_description: new TokenRateLimitedError().message,
						problem: 'rate-limited'
					}
				},
				keys: Array.from({ length: budget + 1 }, () =>
					JSON.stringify({ ...surface, address })
				)
			});
		}
	);

	it.each([
		{
			name: 'another address',
			spent: post('/token'),
			probe: post('/token', '2001:db8::1'),
			status: StatusCodes.BAD_REQUEST
		},
		{
			name: 'another IPv6 /64 prefix',
			spent: post('/token', '2001:db8::1'),
			probe: post('/token', '2001:db8:0:1::1'),
			status: StatusCodes.BAD_REQUEST
		},
		{
			name: 'a tenant',
			spent: post('/token'),
			probe: post('/t/acme/token'),
			status: StatusCodes.NOT_FOUND
		},
		{
			name: 'another tenant',
			spent: post('/t/acme/token'),
			probe: post('/t/other/token'),
			status: StatusCodes.NOT_FOUND
		},
		{
			name: 'the control plane',
			spent: post('/t/acme/token'),
			probe: post('/signup'),
			status: StatusCodes.BAD_REQUEST
		}
	])('keeps a separate budget for $name', async ({ spent, probe, status }) => {
		const { limiter } = countingLimiter(budget);
		await spendBudget(spent, limiter);
		const refused = await statusOf(spent, limiter);
		const separate = await statusOf(probe, limiter);

		expect({ refused, separate }).toStrictEqual({
			refused: StatusCodes.TOO_MANY_REQUESTS,
			separate: status
		});
	});

	it.each([
		{ address: '192.0.2.1', client: '192.0.2.1' },
		{ address: '2001:db8::1', client: '2001:db8:0:0::/64' },
		{
			address: '2001:0DB8:0000:0000:ffff:0000:0000:0002',
			client: '2001:db8:0:0::/64'
		},
		{ address: '2001:db8:0:1::', client: '2001:db8:0:1::/64' },
		{ address: '::1', client: '0:0:0:0::/64' },
		{ address: '::ffff:192.0.2.1', client: '192.0.2.1' },
		{ address: '::ffff:c000:201', client: '192.0.2.1' }
	])(
		'counts a request from $address against $client',
		async ({ address: from, client }) => {
			const { limiter, keys } = countingLimiter(budget);
			await statusOf(post('/token', from), limiter);

			expect(keys).toStrictEqual([
				JSON.stringify({ kind: 'control', address: client })
			]);
		}
	);

	it.each([
		{
			name: 'two addresses in one IPv6 /64 prefix',
			spent: '2001:db8::1',
			probe: '2001:db8::ffff:2'
		},
		{
			name: 'an IPv4 address and its IPv4-mapped IPv6 form',
			spent: '192.0.2.1',
			probe: '::ffff:192.0.2.1'
		}
	])('shares one budget between $name', async ({ spent, probe }) => {
		const { limiter } = countingLimiter(budget);
		await spendBudget(post('/token', spent), limiter);
		const refused = await statusOf(post('/token', probe), limiter);

		expect(refused).toBe(StatusCodes.TOO_MANY_REQUESTS);
	});

	it('does not limit other routes', async () => {
		const { limiter, keys } = countingLimiter(0);
		const probes: Probe[] = [
			{ method: 'GET', path: '/healthz', address },
			{
				method: 'GET',
				path: '/.well-known/oauth-authorization-server',
				address
			},
			{ method: 'GET', path: '/token', address },
			{ method: 'GET', path: '/t/acme/nix-cache-info', address },
			post('/t/acme/uploads')
		];
		const statuses: number[] = [];

		for (const probe of probes) {
			statuses.push(await statusOf(probe, limiter));
		}

		expect({ statuses, keys }).toStrictEqual({
			statuses: [
				StatusCodes.OK,
				StatusCodes.OK,
				StatusCodes.NOT_FOUND,
				StatusCodes.NOT_FOUND,
				StatusCodes.NOT_FOUND
			],
			keys: []
		});
	});
});
