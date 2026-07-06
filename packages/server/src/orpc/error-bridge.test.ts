import { rootLogger } from '@cupboard/logger';
import { type Capture, startCapture } from '@cupboard/logger/testing';
import { ORPCError } from '@orpc/server';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CacheNotEmptyError, UploadNotFoundError } from '../errors.ts';

import { bridgedError } from './error-bridge.ts';

describe('bridgedError', () => {
	let capture: Capture;

	beforeEach(() => {
		capture = startCapture();
	});

	afterEach(() => {
		capture.stop();
	});

	it('maps a CacheNotEmptyError to its defined contract error with data', () => {
		const bridged = bridgedError(
			rootLogger(),
			new CacheNotEmptyError('builds')
		);

		expect(bridged).toBeInstanceOf(ORPCError);
		expect(bridged).toMatchObject({
			code: 'CACHE_NOT_EMPTY',
			status: StatusCodes.CONFLICT,
			message: 'Cache is not empty; pass force to tear it down',
			data: { cache: 'builds' }
		});
		expect(capture.logs).toStrictEqual([]);
	});

	it('keeps the status and message of any other ServerHttpError', () => {
		const bridged = bridgedError(
			rootLogger(),
			new UploadNotFoundError('upload-1')
		);

		expect(bridged).toBeInstanceOf(ORPCError);
		expect(bridged).toMatchObject({
			code: 'NOT_FOUND',
			status: StatusCodes.NOT_FOUND,
			message: 'Upload not found'
		});
		expect(capture.logs).toStrictEqual([]);
	});

	it('passes an ORPCError through untouched and does not log it', () => {
		const orpcError = new ORPCError('UNAUTHORIZED');

		const bridged = bridgedError(rootLogger(), orpcError);

		expect(bridged).toBe(orpcError);
		expect(capture.logs).toStrictEqual([]);
	});

	it('logs an unexpected fault with the logger fields and returns it unchanged', () => {
		const fault = new Error('Too many subrequests');
		const logger = rootLogger().with({ ray: 'a113b23c78faf6c2' });

		const bridged = bridgedError(logger, fault);

		expect(bridged).toBe(fault);
		expect(capture.logs).toHaveLength(1);
		expect(capture.logs[0]).toMatchObject({
			level: 'error',
			message: 'unhandled server error',
			properties: { ray: 'a113b23c78faf6c2', error: fault }
		});
	});
});
