import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import {
	AdminApiTransientError,
	type AdminApiTransientStatus,
	QuotaExceededError,
	ScopeForbiddenError,
	SessionRejectedError
} from '../errors.ts';

import { isRpcNotFoundError, translateRpcError } from './rpc-errors.ts';

describe('isRpcNotFoundError', () => {
	it.each([
		['NOT_FOUND', 404, true],
		['INTERNAL_SERVER_ERROR', 404, false],
		['NOT_FOUND', 503, false]
	])('classifies $code at HTTP $status', (code, status, expected) => {
		expect(isRpcNotFoundError(new ORPCError(code, { status }))).toBe(expected);
	});
});

describe('translateRpcError', () => {
	it.each([
		{ code: 'UNAUTHORIZED', expected: SessionRejectedError },
		{ code: 'FORBIDDEN', expected: ScopeForbiddenError },
		{ code: 'INSUFFICIENT_STORAGE', expected: QuotaExceededError }
	])('translates $code into its CLI error type', ({ code, expected }) => {
		const translated = translateRpcError(
			new ORPCError(code, { status: 400, message: 'raw' })
		);

		expect(translated).toBeInstanceOf(expected);
	});

	it('uses the INSUFFICIENT_STORAGE message as the quota error detail', () => {
		const translated = translateRpcError(
			new ORPCError('INSUFFICIENT_STORAGE', {
				status: 507,
				message: 'Cache builds is over its 10 GB quota.'
			})
		);

		expect(translated).toBeInstanceOf(QuotaExceededError);

		if (translated instanceof QuotaExceededError) {
			expect({
				name: translated.name,
				detail: translated.detail
			}).toStrictEqual({
				name: 'QuotaExceededError',
				detail: 'Cache builds is over its 10 GB quota.'
			});
		}
	});

	it.each([
		{
			code: 'UNAUTHORIZED',
			status: 401,
			keepAuthCause: false,
			expected: () => new SessionRejectedError()
		},
		{
			code: 'UNAUTHORIZED',
			status: 401,
			keepAuthCause: true,
			expected: (cause: ORPCError<string, unknown>) =>
				new SessionRejectedError({ cause })
		},
		{
			code: 'FORBIDDEN',
			status: 403,
			keepAuthCause: false,
			expected: () => new ScopeForbiddenError()
		},
		{
			code: 'FORBIDDEN',
			status: 403,
			keepAuthCause: true,
			expected: (cause: ORPCError<string, unknown>) =>
				new ScopeForbiddenError({ cause })
		},
		{
			code: 'INSUFFICIENT_STORAGE',
			status: 507,
			keepAuthCause: true,
			expected: () => new QuotaExceededError('Over quota')
		}
	])(
		'converts $code with keepAuthCause $keepAuthCause',
		({ code, status, keepAuthCause, expected }) => {
			const error = new ORPCError(code, { status, message: 'Over quota' });
			const translated = translateRpcError(error, { keepAuthCause });
			const expectedError = expected(error);

			expect({ translated, cause: causeOf(translated) }).toStrictEqual({
				translated: expectedError,
				cause: expectedError.cause
			});
		}
	);

	it.each<{ code: string; status: AdminApiTransientStatus }>([
		{ code: 'TIMEOUT', status: 408 },
		{ code: 'TOO_MANY_REQUESTS', status: 429 },
		{ code: 'CACHE_LISTING_PROJECTION_PENDING', status: 503 }
	])(
		'converts a $status oRPC error into a transient admin-API error',
		({ code, status }) => {
			const error = new ORPCError(code, { status });

			expect(translateRpcError(error)).toStrictEqual(
				new AdminApiTransientError(status, code, { cause: error })
			);
		}
	);

	it('converts a 507 without an oRPC error envelope into a quota error', () => {
		const error = new ORPCError('MALFORMED_ORPC_ERROR_RESPONSE', {
			status: 507
		});

		expect(translateRpcError(error)).toStrictEqual(
			new QuotaExceededError('', { cause: error })
		);
	});

	it('returns an unrecognised oRPC code unchanged', () => {
		const error = new ORPCError('NOT_FOUND', {
			status: 404,
			message: 'unchanged'
		});

		expect(translateRpcError(error)).toBe(error);
	});

	it('returns a non-oRPC error unchanged', () => {
		const error = new Error('boom');

		expect(translateRpcError(error)).toBe(error);
	});
});

function causeOf(error: unknown): unknown {
	return error instanceof Error ? error.cause : undefined;
}
