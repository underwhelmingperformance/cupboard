import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	ControlSubjectTokenUntrustedError,
	RefreshTokenRequiredError,
	StaleRefreshTokenError,
	SubjectTokenNotJwtError,
	SubjectTokenRequiredError,
	SubjectTokenSubjectMissingError,
	SubjectTokenVerificationFailedError,
	TenantSubjectTokenUntrustedError,
	TokenRequestBodyInvalidError,
	UnsupportedGrantTypeError,
	UnsupportedSubjectTokenTypeError
} from './errors.ts';

describe('OAuth errors', () => {
	it.each([
		{
			error: new SubjectTokenRequiredError(),
			name: 'SubjectTokenRequiredError',
			code: 'invalid_request',
			problem: 'subject-token-required'
		},
		{
			error: new UnsupportedSubjectTokenTypeError('urn:example:token'),
			name: 'UnsupportedSubjectTokenTypeError',
			code: 'invalid_request',
			problem: 'unsupported-subject-token-type'
		},
		{
			error: new RefreshTokenRequiredError(),
			name: 'RefreshTokenRequiredError',
			code: 'invalid_request',
			problem: 'refresh-token-required'
		},
		{
			error: new TokenRequestBodyInvalidError(new z.ZodError([])),
			name: 'TokenRequestBodyInvalidError',
			code: 'invalid_request',
			problem: 'schema-mismatch'
		},
		{
			error: new StaleRefreshTokenError(),
			name: 'StaleRefreshTokenError',
			code: 'invalid_grant',
			problem: 'stale-refresh-token'
		},
		{
			error: new SubjectTokenNotJwtError(),
			name: 'SubjectTokenNotJwtError',
			code: 'invalid_grant',
			problem: 'subject-token-invalid'
		},
		{
			error: new SubjectTokenVerificationFailedError(),
			name: 'SubjectTokenVerificationFailedError',
			code: 'invalid_grant',
			problem: 'subject-token-invalid'
		},
		{
			error: new SubjectTokenSubjectMissingError(),
			name: 'SubjectTokenSubjectMissingError',
			code: 'invalid_grant',
			problem: 'subject-token-invalid'
		},
		{
			error: new TenantSubjectTokenUntrustedError(),
			name: 'TenantSubjectTokenUntrustedError',
			code: 'invalid_grant',
			problem: 'subject-token-untrusted'
		},
		{
			error: new ControlSubjectTokenUntrustedError(),
			name: 'ControlSubjectTokenUntrustedError',
			code: 'invalid_grant',
			problem: 'subject-token-untrusted'
		}
	])(
		'$name carries its RFC code and problem',
		({ error, name, code, problem }) => {
			expect({
				name: error.name,
				code: error.error,
				problem: error.problem,
				status: error.status
			}).toStrictEqual({
				name,
				code,
				problem,
				status: StatusCodes.BAD_REQUEST
			});
		}
	);

	it('reports an unsupported grant type with the grant and no problem', () => {
		const error = new UnsupportedGrantTypeError('authorization_code');

		expect({
			name: error.name,
			code: error.error,
			grantType: error.grantType,
			problem: error.problem,
			status: error.status
		}).toStrictEqual({
			name: 'UnsupportedGrantTypeError',
			code: 'unsupported_grant_type',
			grantType: 'authorization_code',
			problem: undefined,
			status: StatusCodes.BAD_REQUEST
		});
	});
});
