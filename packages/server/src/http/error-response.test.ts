import { type Capture, startCapture } from '@cupboard/logger/testing';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
	let capture: Capture;

	beforeEach(() => {
		capture = startCapture();
	});

	afterEach(() => {
		capture.stop();
	});

	it('returns the modelled status and message without logging', async () => {
		const response = await appThatThrows(new UnauthenticatedError()).request(
			'/'
		);

		expect({
			status: response.status,
			body: await response.text(),
			logged: capture.logs
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
		'returns a no-store 500 for an unmodelled error, $name',
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

		expect(capture.logs).toHaveLength(1);
		expect(capture.logs[0]).toMatchObject({
			level: 'error',
			message: 'unhandled server error',
			properties: { ray: 'ray-9', error: boom }
		});
	});

	it.each([
		{ flag: 'retryable' },
		{ flag: 'durableObjectReset' },
		{ flag: 'overloaded' }
	])(
		'returns a retryable 503 for a runtime fault marked $flag',
		async ({ flag }) => {
			const fault = Object.assign(new Error('dispatch died'), {
				[flag]: true
			});

			const response = await appThatThrows(fault).request('/', {
				headers: { 'cf-ray': 'ray-77' }
			});

			expect({
				status: response.status,
				retryAfter: response.headers.get('retry-after'),
				cacheControl: response.headers.get('cache-control'),
				body: await response.text(),
				errorLogged: capture.logs.filter((entry) => entry.level === 'error')
			}).toStrictEqual({
				status: 503,
				retryAfter: '5',
				cacheControl: 'no-store',
				body: 'The service was temporarily unavailable\n',
				errorLogged: []
			});
		}
	);

	it('does not treat a false runtime flag as retryable', async () => {
		const fault = Object.assign(new Error('dispatch died'), {
			retryable: false
		});

		const response = await appThatThrows(fault).request('/');

		expect(response.status).toBe(500);
	});

	it.each([
		{
			name: 'direct overload message',
			error: new Error(
				'D1_ERROR: D1 DB is overloaded. Too many requests queued.'
			)
		},
		{
			name: 'overload message in cause chain',
			error: new Error('query failed', {
				cause: new Error(
					'D1_ERROR: D1 DB is overloaded. Too many requests queued.'
				)
			})
		}
	])('returns a retryable 503 for a D1 overload ($name)', async ({ error }) => {
		const response = await appThatThrows(error).request('/');

		expect({
			status: response.status,
			retryAfter: response.headers.get('retry-after'),
			cacheControl: response.headers.get('cache-control'),
			body: await response.text()
		}).toStrictEqual({
			status: 503,
			retryAfter: '5',
			cacheControl: 'no-store',
			body: 'Database is temporarily overloaded\n'
		});
	});
});
