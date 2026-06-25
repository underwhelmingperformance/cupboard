import { ORPCError } from '@orpc/server';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CacheNotEmptyError, UploadNotFoundError } from '../errors.ts';

import { bridgedError } from './error-bridge.ts';

function requestWithRay(ray: string): Request {
	return new Request('https://cupboard.test/t/acme/cache/_default/uploads', {
		headers: { 'cf-ray': ray }
	});
}

describe('bridgedError', () => {
	const logged: unknown[][] = [];

	beforeEach(() => {
		logged.length = 0;
		vi.spyOn(console, 'error').mockImplementation(
			(...logArguments: unknown[]) => {
				logged.push(logArguments);
			}
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('maps a CacheNotEmptyError to its defined contract error with data', () => {
		const bridged = bridgedError(new CacheNotEmptyError('builds'));

		expect(bridged).toBeInstanceOf(ORPCError);
		expect(bridged).toMatchObject({
			code: 'CACHE_NOT_EMPTY',
			status: StatusCodes.CONFLICT,
			message: 'Cache is not empty; pass force to tear it down',
			data: { cache: 'builds' }
		});
		expect(logged).toStrictEqual([]);
	});

	it('keeps the status and message of any other ServerHttpError', () => {
		const bridged = bridgedError(new UploadNotFoundError('upload-1'));

		expect(bridged).toBeInstanceOf(ORPCError);
		expect(bridged).toMatchObject({
			code: 'NOT_FOUND',
			status: StatusCodes.NOT_FOUND,
			message: 'Upload not found'
		});
		expect(logged).toStrictEqual([]);
	});

	it('passes an ORPCError through untouched and does not log it', () => {
		const orpcError = new ORPCError('UNAUTHORIZED');

		const bridged = bridgedError(orpcError, requestWithRay('ray-1'));

		expect(bridged).toBe(orpcError);
		expect(logged).toStrictEqual([]);
	});

	it('logs an unexpected fault with the request ray and returns it unchanged', () => {
		const fault = new Error('Too many subrequests');

		const bridged = bridgedError(fault, requestWithRay('a113b23c78faf6c2'));

		expect(bridged).toBe(fault);
		expect(logged).toStrictEqual([
			['Unhandled server error', { ray: 'a113b23c78faf6c2', error: fault }]
		]);
	});

	it('logs an unexpected fault without a ray when the request is absent', () => {
		const fault = new Error('boom');

		const bridged = bridgedError(fault);

		expect(bridged).toBe(fault);
		expect(logged).toStrictEqual([
			['Unhandled server error', { ray: undefined, error: fault }]
		]);
	});
});
