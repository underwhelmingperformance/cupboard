import { describe, expect, it } from 'vitest';

import {
	AdminApiTransientError,
	type AdminApiTransientStatus,
	QuotaExceededError,
	transientExitCode
} from './errors.ts';

describe('QuotaExceededError', () => {
	it.each([
		{ detail: '', equivalent: 'The cache is over its storage quota.' },
		{
			detail: "This upload would exceed the tenant's storage quota",
			equivalent: "This upload would exceed the tenant's storage quota."
		},
		{
			detail: 'Cache builds is over its 10 GB quota. ',
			equivalent: 'Cache builds is over its 10 GB quota.'
		}
	])(
		'gives detail $detail the same message as $equivalent',
		({ detail, equivalent }) => {
			expect(new QuotaExceededError(detail).message).toBe(
				new QuotaExceededError(equivalent).message
			);
		}
	);

	it('gives different details different messages', () => {
		const messages = [
			'Cache builds is over its 10 GB quota.',
			'Cache docs is over its 5 GB quota.'
		].map((detail) => new QuotaExceededError(detail).message);

		expect(new Set(messages).size).toBe(messages.length);
	});
});

describe('AdminApiTransientError', () => {
	it.each<{ status: AdminApiTransientStatus; code: string }>([
		{ status: 408, code: 'TIMEOUT' },
		{ status: 503, code: 'CACHE_LISTING_PROJECTION_PENDING' }
	])('reports status $status and code $code', ({ status, code }) => {
		const error = new AdminApiTransientError(status, code);

		expect({
			exitCode: error.exitCode,
			status: error.status,
			code: error.code,
			mentions: {
				status: error.message.includes(String(status)),
				code: error.message.includes(code)
			}
		}).toStrictEqual({
			exitCode: transientExitCode,
			status,
			code,
			mentions: { status: true, code: true }
		});
	});
});
