import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { cacheMetadataErrorCodes } from '@cupboard/protocol/cache-metadata';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import {
	MetadataNarInfoInvalidError,
	PublicationResendRequiredError,
	PublicationStagingDeletePendingError,
	QuotaExceededError,
	SharedFactsUnavailableError,
	UploadNotFoundError
} from '../errors.ts';

import { errorFacts, isServerFault } from './refusal-log.ts';

describe('errorFacts', () => {
	it.each([
		{
			name: 'a typed error without a code',
			error: new SharedFactsUnavailableError(new Error('cause')),
			facts: {
				errorName: 'SharedFactsUnavailableError',
				errorStatus: StatusCodes.SERVICE_UNAVAILABLE
			}
		},
		{
			name: 'a typed error with a code',
			error: new MetadataNarInfoInvalidError(undefined, new Error('cause')),
			facts: {
				errorName: 'MetadataNarInfoInvalidError',
				errorCode: cacheMetadataErrorCodes.narInfoInvalid,
				errorStatus: StatusCodes.INTERNAL_SERVER_ERROR
			}
		},
		{
			name: 'a plain error',
			error: new Error('https://r2.example/secret?signature=abc'),
			facts: { errorName: 'Error' }
		},
		{
			name: 'an error with a string code',
			error: Object.assign(new Error('failed'), { code: 'ECONNRESET' }),
			facts: { errorName: 'Error', errorCode: 'ECONNRESET' }
		},
		{ name: 'a string', error: 'https://r2.example', facts: {} },
		{ name: 'undefined', error: undefined, facts: {} }
	])('returns the class name, code and status of $name', ({ error, facts }) => {
		expect(errorFacts(error)).toStrictEqual(facts);
	});
});

describe('isServerFault', () => {
	it.each([
		{
			name: 'a 503',
			error: new SharedFactsUnavailableError(new Error('cause')),
			isFault: true
		},
		{
			name: 'a 500',
			error: new MetadataNarInfoInvalidError(undefined, new Error('cause')),
			isFault: true
		},
		{
			name: 'a 507 expected refusal',
			error: new QuotaExceededError(tenantIdSchema.parse('acme')),
			isFault: false
		},
		{
			name: 'a 503 expected refusal',
			error: new PublicationResendRequiredError(),
			isFault: false
		},
		{
			name: 'a 503 race with a delete',
			error: new PublicationStagingDeletePendingError(),
			isFault: false
		},
		{
			name: 'a 404',
			error: new UploadNotFoundError(uploadIdSchema.parse('upload')),
			isFault: false
		}
	])('is $isFault for $name', ({ error, isFault }) => {
		expect(isServerFault(error)).toBe(isFault);
	});
});
