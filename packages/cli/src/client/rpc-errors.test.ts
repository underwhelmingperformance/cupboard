import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import {
	QuotaBelowUsageError,
	QuotaExceededError,
	ScopeForbiddenError,
	SessionRejectedError,
	TenantRemovalInProgressError
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

	it('names the tenant when it refuses a status change during removal', () => {
		const translated = translateRpcError(
			new ORPCError('TENANT_OFFBOARDING', {
				status: 409,
				message: 'raw',
				data: { id: 'beta' }
			})
		);

		expect(translated).toBeInstanceOf(TenantRemovalInProgressError);

		if (translated instanceof TenantRemovalInProgressError) {
			expect({
				tenant: translated.tenant,
				message: translated.message
			}).toStrictEqual({
				tenant: 'beta',
				message:
					'Tenant beta is being removed, so its status and quota can no ' +
					'longer be changed. Removal cannot be undone; `cupboard tenant ' +
					'list` shows its progress.'
			});
		}
	});

	it('reports the charged bytes when a quota would be below them', () => {
		const translated = translateRpcError(
			new ORPCError('TENANT_QUOTA_BELOW_USAGE', {
				status: 409,
				message: 'raw',
				data: { id: 'beta', usedBytes: 2_000_000 }
			})
		);

		expect(translated).toBeInstanceOf(QuotaBelowUsageError);
		expect(translated instanceof Error ? translated.message : '').toBe(
			'Tenant beta already stores 2 MB (2000000 bytes), more than the ' +
				'requested quota. Choose a larger quota, or free space first.'
		);
	});

	it('advises raising the quota or freeing space when an upload is over quota', () => {
		const translated = translateRpcError(
			new ORPCError('INSUFFICIENT_STORAGE', {
				status: 507,
				message: "This upload would exceed the tenant's storage quota"
			})
		);

		expect(translated instanceof Error ? translated.message : '').toBe(
			"This upload would exceed the tenant's storage quota. Ask the " +
				"deployment's operator to raise the tenant's quota (`cupboard " +
				'tenant set-quota`), or free space: delete paths you no longer need ' +
				'(`cupboard delete`), or remove roots (`cupboard root remove`) and ' +
				'let garbage collection reclaim what they kept.'
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
