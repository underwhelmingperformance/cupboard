import { StatusCodes } from 'http-status-codes';

import { constantTimeEqual, sha256HexBytes } from '../crypto/crypto.ts';

const textEncoder = new TextEncoder();
const readPasswordHashDomain = 'cupboard-read-password-v1';

export interface ReadCredential {
	readonly user: string;
	readonly password: string;
}

export interface ReadVerifier {
	readonly user: string;
	readonly passwordHash: string;
	readonly passwordSalt: string;
}

/** Hashes a read password the same way the verifier stores it, for comparison. */
export function hashReadPassword(
	password: string,
	salt: string
): Promise<string> {
	return sha256HexBytes(
		textEncoder.encode(`${readPasswordHashDomain}\0${salt}\0${password}`)
	);
}

export function generateReadPasswordSalt(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);

	return base64Url(bytes);
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

function base64Url(bytes: Uint8Array): string {
	const binary = String.fromCodePoint(...bytes);

	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
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
