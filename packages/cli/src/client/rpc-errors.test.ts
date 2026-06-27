import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import {
	CupboardUploadError,
	QuotaExceededError,
	ScopeForbiddenError,
	SessionRejectedError
} from '../errors.ts';

import { isExpiredUploadUrlError, translateRpcError } from './rpc-errors.ts';

const expiredBody =
	'<Error><Code>ExpiredRequest</Code><Message>Request has expired</Message></Error>';
const deniedBody =
	'<Error><Code>AccessDenied</Code><Message>no</Message></Error>';

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

	it('carries the server detail in the quota error', () => {
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
		const error = new ORPCError('NOT_FOUND', { status: 404, message: 'gone' });

		expect(translateRpcError(error)).toBe(error);
	});

	it('returns a non-oRPC error unchanged', () => {
		const error = new Error('boom');

		expect(translateRpcError(error)).toBe(error);
	});
});

describe('isExpiredUploadUrlError', () => {
	it.each([
		{
			name: 'a 403 ExpiredRequest',
			error: new CupboardUploadError(
				'nar/key',
				StatusCodes.FORBIDDEN,
				expiredBody
			),
			expected: true
		},
		{
			name: 'a 403 with another code',
			error: new CupboardUploadError(
				'nar/key',
				StatusCodes.FORBIDDEN,
				deniedBody
			),
			expected: false
		},
		{
			name: 'an ExpiredRequest with a non-403 status',
			error: new CupboardUploadError(
				'nar/key',
				StatusCodes.BAD_REQUEST,
				expiredBody
			),
			expected: false
		},
		{ name: 'an unrelated error', error: new Error('boom'), expected: false }
	])('is $expected for $name', ({ error, expected }) => {
		expect(isExpiredUploadUrlError(error)).toBe(expected);
	});
});
