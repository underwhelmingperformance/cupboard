import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import {
	InvalidGrantError,
	InvalidRequestError,
	UnsupportedGrantTypeError
} from './errors.ts';

describe('OAuth errors', () => {
	it.each([
		{
			error: new InvalidRequestError('grant_type is required'),
			code: 'invalid_request',
			status: StatusCodes.BAD_REQUEST,
			message: 'grant_type is required'
		},
		{
			error: new InvalidGrantError('subject token is not trusted'),
			code: 'invalid_grant',
			status: StatusCodes.BAD_REQUEST,
			message: 'subject token is not trusted'
		},
		{
			error: new UnsupportedGrantTypeError('authorization_code'),
			code: 'unsupported_grant_type',
			status: StatusCodes.BAD_REQUEST,
			message: 'Unsupported grant type: authorization_code'
		}
	])(
		'$code carries its code, status and description',
		({ error, code, status, message }) => {
			expect({
				error: error.error,
				status: error.status,
				message: error.message
			}).toStrictEqual({ error: code, status, message });
		}
	);
});
