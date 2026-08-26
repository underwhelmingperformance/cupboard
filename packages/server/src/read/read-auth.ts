import { bytesToBase64Url } from '@cupboard/nix-store/encoding';
import { parseBasicAuthHeader, type ReadUser } from '@cupboard/shared/http';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { isConstantTimeEqual, sha256HexBytes } from '../crypto/crypto.ts';

const textEncoder = new TextEncoder();
const readPasswordHashDomain = 'cupboard-read-password-v1';
// A SHA-256 digest rendered as lower-case hexadecimal is 64 ASCII bytes.
const readPasswordHashByteLength = 64;

// Separate brands prevent callers from passing a password hash where a salt or
// read user is required.
export const readPasswordHashSchema = z
	.string()
	.regex(/^[0-9a-f]{64}$/u, 'unsupported read-password verifier format')
	.brand('ReadPasswordHash');
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
 * Creates the verifier stored for a private-read credential. Changing this
 * encoding invalidates existing credentials.
 *
 * The verifier is a salted digest, so the credential is protected by the
 * password's own entropy. `readPasswordSchema` requires 32 random bytes, which
 * leaves an attacker holding a stolen verifier the whole 256-bit space to
 * search.
 */
export async function hashReadPassword(
	password: string,
	salt: ReadPasswordSalt
): Promise<ReadPasswordHash> {
	const digest = await sha256HexBytes(
		textEncoder.encode(`${readPasswordHashDomain}\0${salt}\0${password}`)
	);

	return readPasswordHashSchema.parse(digest);
}

export async function isReadPasswordMatching(
	password: string,
	passwordHash: ReadPasswordHash,
	salt: ReadPasswordSalt
): Promise<boolean> {
	const candidate = await hashReadPassword(password, salt);

	return isConstantTimeEqual(
		candidate,
		passwordHash,
		readPasswordHashByteLength
	);
}

export function generateReadPasswordSalt(): ReadPasswordSalt {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);

	return readPasswordSaltSchema.parse(bytesToBase64Url(bytes));
}

/**
 * Whether a request contains HTTP Basic credentials matching the tenant's read
 * verifier. The password verifier uses fixed-length cryptographic comparison and
 * is checked even when the user differs, so a user mismatch does not skip the
 * password work.
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
	const isUserMatching = user === verifier.user;
	const isPasswordMatching = await isReadPasswordMatching(
		password,
		verifier.passwordHash,
		verifier.passwordSalt
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
