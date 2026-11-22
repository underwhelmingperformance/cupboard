import { StatusCodes } from 'http-status-codes';
import { type z } from 'zod';

// The column types of the retired static read verifier in D1. No runtime
// service reads or writes these columns.
export type ReadPasswordHash = string & z.$brand<'ReadPasswordHash'>;
export type ReadPasswordSalt = string & z.$brand<'ReadPasswordSalt'>;

export function unauthorisedResponse(): Response {
	return new Response('Unauthorised\n', {
		status: StatusCodes.UNAUTHORIZED,
		headers: {
			'www-authenticate': 'Basic realm="cupboard"',
			'cache-control': 'no-store'
		}
	});
}
