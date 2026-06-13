import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import {
	QuotaExceededError,
	ScopeForbiddenError,
	SessionRejectedError
} from '../errors.ts';

import { translateRpcError } from './rpc-errors.ts';

describe('translateRpcError', () => {
	it.each([
		{ code: 'UNAUTHORIZED', expected: SessionRejectedError },
		{ code: 'FORBIDDEN', expected: ScopeForbiddenError },
		{ code: 'INSUFFICIENT_STORAGE', expected: QuotaExceededError }
	])('maps $code to a friendly error', ({ code, expected }) => {
		const translated = translateRpcError(
			new ORPCError(code, { status: 400, message: 'raw' })
		);

		expect(translated).toBeInstanceOf(expected);
	});

	it('surfaces the server message in the quota error', () => {
		const translated = translateRpcError(
			new ORPCError('INSUFFICIENT_STORAGE', {
				status: 507,
				message: 'Cache builds is over its 10 GB quota.'
			})
		);

		expect((translated as Error).message).toBe(
			'Cache builds is over its 10 GB quota. ' +
				'Free space by deleting unused paths or raise the quota.'
		);
	});

	it('returns an unrecognised oRPC code unchanged', () => {
		const error = new ORPCError('NOT_FOUND', { status: 404, message: 'gone' });

		expect(translateRpcError(error)).toBe(error);
	});

	it('returns a non-oRPC error unchanged', () => {
		const error = new Error('boom');

		expect(translateRpcError(error)).toBe(error);
	});
});
