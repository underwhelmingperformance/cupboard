import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UnauthenticatedError } from '../errors.ts';

import { serverErrorHandler } from './error-response.ts';

function appThatThrows(error: unknown): Hono {
	const app = new Hono();
	app.onError(serverErrorHandler);
	app.get('/', () => {
		throw error;
	});

	return app;
}

describe('serverErrorHandler', () => {
	const logged: unknown[][] = [];

	beforeEach(() => {
		logged.length = 0;
		vi.spyOn(console, 'error').mockImplementation(
			(...logArguments: unknown[]) => {
				logged.push(logArguments);
			}
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('maps a modelled ServerHttpError to its status and message', async () => {
		const response = await appThatThrows(new UnauthenticatedError()).request(
			'/'
		);

		expect({
			status: response.status,
			body: await response.text(),
			logged
		}).toStrictEqual({
			status: 401,
			body: 'Unauthorised\n',
			logged: []
		});
	});

	it.each([
		{
			name: 'carrying the request ray when present',
			headers: { 'cf-ray': 'ray-123' } as Record<string, string>,
			expectedBody: { error: 'internal_error', ray: 'ray-123' }
		},
		{
			name: 'omitting the ray when the request carries none',
			headers: {},
			expectedBody: { error: 'internal_error' }
		}
	])(
		'answers an unmodelled error as a no-store 500, $name',
		async ({ headers, expectedBody }) => {
			const response = await appThatThrows(new Error('boom')).request('/', {
				headers
			});

			expect({
				status: response.status,
				cacheControl: response.headers.get('cache-control'),
				body: await response.json()
			}).toStrictEqual({
				status: 500,
				cacheControl: 'no-store',
				body: expectedBody
			});
		}
	);

	it('logs the full error against the ray for an unmodelled fault', async () => {
		const boom = new Error('boom');

		await appThatThrows(boom).request('/', { headers: { 'cf-ray': 'ray-9' } });

		expect(logged).toStrictEqual([
			['Unhandled server error', { ray: 'ray-9', error: boom }]
		]);
	});
});
