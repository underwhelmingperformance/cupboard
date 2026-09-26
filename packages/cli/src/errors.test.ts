import { describe, expect, it } from 'vitest';

import {
	AdminApiTransientError,
	type AdminApiTransientStatus,
	QuotaExceededError
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

	it("follows the server's detail with the advice", () => {
		expect(
			new QuotaExceededError(
				"This upload would exceed the tenant's storage quota"
			).message
		).toBe(
			"This upload would exceed the tenant's storage quota. Free space by deleting unused paths or raise the quota."
		);
	});
});

describe('AdminApiTransientError', () => {
	it.each<{
		status: AdminApiTransientStatus;
		code: string;
		message: string;
	}>([
		{
			status: 408,
			code: 'TIMEOUT',
			message:
				'The admin API responded with 408 (TIMEOUT). Run the command again later.'
		},
		{
			status: 503,
			code: 'CACHE_LISTING_PROJECTION_PENDING',
			message:
				'The admin API responded with 503 (CACHE_LISTING_PROJECTION_PENDING). Run the command again later.'
		}
	])('reports status $status and code $code', ({ status, code, message }) => {
		const error = new AdminApiTransientError(status, code);

		expect({
			exitCode: error.exitCode,
			status: error.status,
			code: error.code,
			message: error.message
		}).toStrictEqual({ exitCode: 75, status, code, message });
	});
});
