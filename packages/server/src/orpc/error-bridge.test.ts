import { rootLogger } from '@cupboard/logger';
import { type Capture, startCapture } from '@cupboard/logger/testing';
import {
	cacheNameSchema,
	signingKeyIdSchema
} from '@cupboard/nix-store/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { ORPCError } from '@orpc/server';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	CacheAlreadyExistsError,
	CacheNotEmptyError,
	CacheNotFoundError,
	CommitSessionLimitError,
	SigningKeyBackfillIncompleteError,
	SigningKeyRotationAbortNotAllowedError,
	SigningKeyRotationInProgressError,
	UploadNotFoundError
} from '../errors.ts';

import { bridgedError } from './error-bridge.ts';

describe('bridgedError', () => {
	let capture: Capture;
	const incomingKeyId = signingKeyIdSchema.parse(
		'123e4567-e89b-12d3-a456-426614174000'
	);

	beforeEach(() => {
		capture = startCapture();
	});

	afterEach(() => {
		capture.stop();
	});

	it('returns CACHE_NOT_EMPTY with the cache name', () => {
		const bridged = bridgedError(
			rootLogger(),
			new CacheNotEmptyError({
				kind: 'named',
				name: cacheNameSchema.parse('builds')
			})
		);

		expect(bridged).toBeInstanceOf(ORPCError);
		expect(bridged).toMatchObject({
			code: 'CACHE_NOT_EMPTY',
			status: StatusCodes.CONFLICT,
			message:
				'The cache contains store paths. Set force to true to delete it.',
			data: { cache: { kind: 'named', name: 'builds' } }
		});
		expect(capture.logs).toStrictEqual([]);
	});

	it('returns CACHE_ALREADY_EXISTS with the cache scope', () => {
		const bridged = bridgedError(
			rootLogger(),
			new CacheAlreadyExistsError({ kind: 'default' })
		);

		expect(bridged).toBeInstanceOf(ORPCError);
		expect(bridged).toMatchObject({
			code: 'CACHE_ALREADY_EXISTS',
			status: StatusCodes.CONFLICT,
			message: 'The requested cache already exists',
			data: { cache: { kind: 'default' } }
		});
		expect(capture.logs).toStrictEqual([]);
	});

	it('returns CACHE_NOT_FOUND with the cache scope', () => {
		const bridged = bridgedError(
			rootLogger(),
			new CacheNotFoundError({ kind: 'default' })
		);

		expect(bridged).toBeInstanceOf(ORPCError);
		expect(bridged).toMatchObject({
			code: 'CACHE_NOT_FOUND',
			status: StatusCodes.NOT_FOUND,
			message: 'The requested cache does not exist',
			data: { cache: { kind: 'default' } }
		});
		expect(capture.logs).toStrictEqual([]);
	});

	it('preserves the status and message of a generic ServerHttpError', () => {
		const bridged = bridgedError(
			rootLogger(),
			new UploadNotFoundError(uploadIdSchema.parse('upload-1'))
		);

		expect(bridged).toBeInstanceOf(ORPCError);
		expect(bridged).toMatchObject({
			code: 'NOT_FOUND',
			status: StatusCodes.NOT_FOUND,
			message: 'Upload not found'
		});
		expect(capture.logs).toStrictEqual([]);
	});

	it('preserves retry metadata in the oRPC response headers', () => {
		const headers = new Headers();

		bridgedError(rootLogger(), new CommitSessionLimitError(10), headers);

		expect(Object.fromEntries(headers)).toStrictEqual({
			'cache-control': 'no-store',
			'retry-after': '5'
		});
	});

	it.each([
		{
			name: 'an active rotation',
			error: new SigningKeyRotationInProgressError(incomingKeyId),
			code: 'SIGNING_KEY_ROTATION_IN_PROGRESS',
			message: 'A signing key backfill is already in progress'
		},
		{
			name: 'an incomplete backfill',
			error: new SigningKeyBackfillIncompleteError(incomingKeyId),
			code: 'SIGNING_KEY_BACKFILL_INCOMPLETE',
			message: 'The signing key cannot be retired until backfill is complete'
		},
		{
			name: 'a rotation which cannot be aborted',
			error: new SigningKeyRotationAbortNotAllowedError(incomingKeyId),
			code: 'SIGNING_KEY_ROTATION_ABORT_NOT_ALLOWED',
			message: 'Only an incomplete incoming signing key can be aborted'
		}
	])('maps $name to its defined contract error', ({ error, code, message }) => {
		const bridged = bridgedError(rootLogger(), error);

		expect(bridged).toBeInstanceOf(ORPCError);
		expect(bridged).toMatchObject({
			code,
			status: StatusCodes.CONFLICT,
			message,
			data: { id: incomingKeyId }
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
