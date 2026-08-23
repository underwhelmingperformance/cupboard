import { bytesToBase64Url } from '@cupboard/nix-store/encoding';
import { parseBasicAuthHeader, type ReadUser } from '@cupboard/shared/http';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { isConstantTimeEqual, sha256HexBytes } from '../crypto/crypto.ts';

const textEncoder = new TextEncoder();
const readPasswordHashDomain = 'cupboard-read-password-v1';

// Separate brands prevent callers from passing a password hash where a salt or
// read user is required.
export const readPasswordHashSchema = z.string().brand('ReadPasswordHash');
export type ReadPasswordHash = z.infer<typeof readPasswordHashSchema>;

export const readPasswordSaltSchema = z.string().brand('ReadPasswordSalt');
export type ReadPasswordSalt = z.infer<typeof readPasswordSaltSchema>;

// The Basic user and stored password verifier for a private tenant. The
// plaintext password is neither persisted nor forwarded to the tenant Worker.
export interface ReadVerifier {
	readonly user: ReadUser;
	readonly passwordHash: ReadPasswordHash;
	readonly passwordSalt: ReadPasswordSalt;
}

/**
 * Uses the stable, versioned encoding for stored read verifiers. Changing it
 * invalidates existing credentials.
 */
export async function hashReadPassword(
	password: string,
	salt: ReadPasswordSalt
): Promise<ReadPasswordHash> {
	return readPasswordHashSchema.parse(
		await sha256HexBytes(
			textEncoder.encode(`${readPasswordHashDomain}\0${salt}\0${password}`)
		)
	);
}

export function generateReadPasswordSalt(): ReadPasswordSalt {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);

	return readPasswordSaltSchema.parse(bytesToBase64Url(bytes));
}

/**
 * After parsing a valid Basic credential, always hashes the password and
 * performs both comparisons before combining their results. A different user
 * does not skip the password comparison.
 */
export async function isReadAuthorised(
	request: Request,
	verifier: ReadVerifier
): Promise<boolean> {
	const parsed = parseBasicAuthHeader(
		request.headers.get('authorization') ?? undefined
	);

	if (!parsed.ok) {
		return false;
	}

	const { user, password } = parsed.credential;
	const passwordHash = await hashReadPassword(password, verifier.passwordSalt);

	const isUserMatching = isConstantTimeEqual(user, verifier.user);
	const isPasswordMatching = isConstantTimeEqual(
		passwordHash,
		verifier.passwordHash
	);

	return isUserMatching && isPasswordMatching;
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
