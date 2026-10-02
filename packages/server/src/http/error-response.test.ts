import { type Capture, startCapture } from '@cupboard/logger/testing';
import { storePathSchema } from '@cupboard/nix-store/scalars';
import {
	cacheMetadataErrorCodes,
	cacheMetadataErrorSchema
} from '@cupboard/protocol/cache-metadata';
import { Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	InsufficientScopeError,
	InvalidAccessTokenError,
	MetadataNarInfoInvalidError,
	MetadataNarInfoTooLargeError,
	UnauthenticatedError,
	UploadRequestLimitExceededError
} from '../errors.ts';

import { serverErrorHandler } from './error-response.ts';

class SerializedRpcError extends Error {
	constructor(name: string) {
		super('provider-private-detail');
		this.name = name;
	}
}

function appThatThrows(error: unknown): Hono {
	const app = new Hono();
	app.onError(serverErrorHandler);
	app.get('/', () => {
		throw error;
	});

	return app;
}

describe('serverErrorHandler', () => {
	it('returns a typed nonretryable upload request limit at the Worker boundary', async () => {
		const error = new UploadRequestLimitExceededError(100);
		const response = await appThatThrows(error).request('/');
		expect({
			status: response.status,
			headers: Object.fromEntries(response.headers),
			body: await response.json()
		}).toStrictEqual({
			status: 413,
			headers: {
				'cache-control': 'no-store',
				'content-type': 'application/json',
				'x-cupboard-upload-max-paths': '100'
			},
			body: {
				defined: true,
				code: 'UPLOAD_REQUEST_LIMIT_EXCEEDED',
				status: 413,
				message: error.message,
				data: { maxPaths: 100 }
			}
		});
	});

	let capture: Capture;

	beforeEach(() => {
		capture = startCapture();
	});

	afterEach(() => {
		capture.stop();
	});

	it.each([
		{
			name: 'a missing credential',
			error: new UnauthenticatedError(),
			status: StatusCodes.UNAUTHORIZED,
			challenge: 'Bearer realm="cupboard"',
			cacheControl: 'no-store',
			body: 'Unauthorised\n'
		},
		{
			name: 'an invalid access token',
			error: new InvalidAccessTokenError(),
			status: 401,
			challenge: 'Bearer realm="cupboard", error="invalid_token"',
			cacheControl: 'no-store',
			body: 'Unauthorised\n'
		},
		{
			name: 'an insufficiently scoped token',
			error: new InsufficientScopeError(),
			status: StatusCodes.FORBIDDEN,
			challenge: 'Bearer realm="cupboard", error="insufficient_scope"',
			cacheControl: 'no-store',
			body: 'Forbidden\n'
		}
	])(
		'maps $name to its Bearer response',
		async ({ error, status, challenge, cacheControl, body }) => {
			const response = await appThatThrows(error).request('/');

			expect({
				status: response.status,
				challenge: response.headers.get('www-authenticate'),
				cacheControl: response.headers.get('cache-control'),
				body: await response.text(),
				logged: capture.logs
			}).toStrictEqual({
				status,
				challenge,
				cacheControl,
				body,
				logged: []
			});
		}
	);

	it.each([
		'LocalSchemaMigrationPendingError',
		'CacheCatalogueMigrationPendingError'
	])(
		'translates a serialized %s without exposing its message',
		async (name) => {
			const error = new SerializedRpcError(name);
			const response = await appThatThrows(error).request('/');
			expect({
				status: response.status,
				retryAfter: response.headers.get('retry-after'),
				cacheControl: response.headers.get('cache-control'),
				body: await response.text(),
				logged: capture.logs
			}).toStrictEqual({
				status: 503,
				retryAfter: '1',
				cacheControl: 'no-store',
				body: 'Tenant migration is still in progress; retry shortly\n',
				logged: []
			});
		}
	);

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

	it.each(['invalid', 'too-large', 'unscoped'] as const)(
		'serialises the affected path for a %s metadata error',
		async (kind) => {
			const storePath = storePathSchema.parse(
				`/nix/store/${'3'.repeat(32)}-metadata`
			);
			const error =
				kind === 'too-large'
					? new MetadataNarInfoTooLargeError(storePath, 1024)
					: new MetadataNarInfoInvalidError(
							kind === 'unscoped' ? undefined : storePath,
							new Error('invalid metadata')
						);
			const response = await appThatThrows(error).request('/');
			const body = cacheMetadataErrorSchema.parse(await response.json());
			expect({
				status: response.status,
				cacheControl: response.headers.get('cache-control'),
				body
			}).toStrictEqual({
				status:
					kind === 'too-large'
						? StatusCodes.REQUEST_TOO_LONG
						: StatusCodes.INTERNAL_SERVER_ERROR,
				cacheControl: 'no-store',
				body: {
					code:
						kind === 'too-large'
							? cacheMetadataErrorCodes.narInfoTooLarge
							: cacheMetadataErrorCodes.narInfoInvalid,
					message: error.message,
					...(kind !== 'unscoped' && { storePath })
				}
			});
		}
	);

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
