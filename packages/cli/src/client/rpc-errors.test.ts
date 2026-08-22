import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import {
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
