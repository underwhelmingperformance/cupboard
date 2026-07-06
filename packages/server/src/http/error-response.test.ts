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

	it('maps a modelled ServerHttpError to its status and message', async () => {
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
		'answers a runtime fault marked $flag as a retryable 503',
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
				body: await response.text(),
				errorLogged: capture.logs.filter((entry) => entry.level === 'error')
			}).toStrictEqual({
				status: 503,
				retryAfter: '5',
				body: 'Tenant is temporarily unavailable\n',
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
});
