import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { InsecureTransportError } from '../errors.ts';

import worker from './handler.ts';

interface ObservedResponse {
	readonly status: number;
	readonly strictTransportSecurity: string | undefined;
	readonly cacheControl: string | undefined;
	readonly body: unknown;
}

async function fetchWorker(
	url: string,
	init: RequestInit,
	localDevelopment: string
): Promise<ObservedResponse> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request(url, init),
		{ ...env, CUPBOARD_LOCAL_DEV: localDevelopment },
		ctx
	);
	await waitOnExecutionContext(ctx);
	const isJson =
		response.headers.get('content-type')?.startsWith('application/json') ??
		false;

	return {
		status: response.status,
		strictTransportSecurity:
			response.headers.get('strict-transport-security') ?? undefined,
		cacheControl: response.headers.get('cache-control') ?? undefined,
		body: isJson ? await response.json() : await response.text()
	};
}

const refreshRequest: RequestInit = {
	method: 'POST',
	headers: { 'content-type': 'application/x-www-form-urlencoded' },
	body: 'grant_type=refresh_token&refresh_token=secret'
};

describe('transport security', () => {
	it.each([
		{ name: 'a health check', path: '/healthz', init: {} },
		{ name: 'a control token request', path: '/token', init: refreshRequest },
		{
			name: 'a tenant token request',
			path: '/t/acme/token',
			init: refreshRequest
		},
		{ name: 'a cache read', path: '/t/acme/nix-cache-info', init: {} }
	])(
		'refuses $name over plain HTTP without an HSTS header',
		async ({ path, init }) => {
			expect(
				await fetchWorker(`http://cupboard.test${path}`, init, '')
			).toStrictEqual({
				status: StatusCodes.FORBIDDEN,
				strictTransportSecurity: undefined,
				cacheControl: 'no-store',
				body: {
					error: 'invalid_request',
					error_description: new InsecureTransportError().message,
					problem: 'insecure-transport'
				}
			});
		}
	);

	it('sends an HSTS header with an HTTPS response', async () => {
		expect(
			await fetchWorker('https://cupboard.test/healthz', {}, '')
		).toStrictEqual({
			status: StatusCodes.OK,
			strictTransportSecurity: 'max-age=31536000',
			cacheControl: 'no-store',
			body: 'ok\n'
		});
	});

	it('sends an HSTS header with an HTTPS error response', async () => {
		const { body: _body, ...observed } = await fetchWorker(
			'https://cupboard.test/token',
			refreshRequest,
			''
		);

		expect(observed).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			strictTransportSecurity: 'max-age=31536000',
			cacheControl: 'no-store'
		});
	});

	it.each(['1', 'true'])(
		'serves plain HTTP without an HSTS header when CUPBOARD_LOCAL_DEV is %s',
		async (localDevelopment) => {
			expect(
				await fetchWorker('http://cupboard.test/healthz', {}, localDevelopment)
			).toStrictEqual({
				status: StatusCodes.OK,
				strictTransportSecurity: undefined,
				cacheControl: 'no-store',
				body: 'ok\n'
			});
		}
	);
});
