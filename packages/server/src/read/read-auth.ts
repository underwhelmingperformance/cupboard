import { StatusCodes } from 'http-status-codes';

import { constantTimeEqual } from '../crypto/crypto.ts';

export interface ReadCredential {
	readonly user: string;
	readonly password: string;
}

interface ReadModeEnv {
	readonly CUPBOARD_READ_USER: string;
	readonly CUPBOARD_READ_PASSWORD: string;
}

/**
 * The configured read credential when private-read mode is on, or `undefined`
 * when the cache is public. Both variables must be set and non-empty: a missing
 * or half-configured deployment stays public rather than locking everyone out
 * with a blank or absent password.
 */
export function readCredential(env: ReadModeEnv): ReadCredential | undefined {
	const user = env.CUPBOARD_READ_USER;
	const password = env.CUPBOARD_READ_PASSWORD;

	if (!user || !password) {
		return undefined;
	}

	return { user, password };
}

/**
 * Whether a request carries HTTP Basic credentials matching the configured
 * read credential. Both fields are compared in constant time and unconditionally
 * so a mismatch in the user does not short-circuit the password comparison.
 */
export function authoriseRead(
	request: Request,
	credential: ReadCredential
): boolean {
	const header = request.headers.get('authorization');

	if (header?.startsWith('Basic ') !== true) {
		return false;
	}

	const decoded = decodeBasic(header.slice('Basic '.length));

	if (decoded === undefined) {
		return false;
	}

	const separator = decoded.indexOf(':');
	const user = separator === -1 ? decoded : decoded.slice(0, separator);
	const password = separator === -1 ? '' : decoded.slice(separator + 1);

	const userMatches = constantTimeEqual(user, credential.user);
	const passwordMatches = constantTimeEqual(password, credential.password);

	return userMatches && passwordMatches;
}

export function unauthorisedResponse(): Response {
	return new Response('Unauthorised\n', {
		status: StatusCodes.UNAUTHORIZED,
		headers: {
			'www-authenticate': 'Basic realm="cupboard"',
			'cache-control': 'no-store'
		}
	});
}

function decodeBasic(value: string): string | undefined {
	try {
		const binary = atob(value);

		return new TextDecoder().decode(
			Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0)
		);
	} catch {
		return undefined;
	}
}
