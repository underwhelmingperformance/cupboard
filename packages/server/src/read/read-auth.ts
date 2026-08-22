import { bytesToBase64Url } from '@cupboard/nix-store/encoding';
import { parseBasicAuthHeader, type ReadUser } from '@cupboard/shared/http';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { isConstantTimeEqual, sha256HexBytes } from '../crypto/crypto.ts';

const textEncoder = new TextEncoder();
const readPasswordHashDomain = 'cupboard-read-password-v1';
const readPasswordKdfDomain = 'cupboard-read-password-v2';
const readPasswordKdfIterations = 600_000;
const readPasswordKdfPrefix = `pbkdf2-sha256$${String(
	readPasswordKdfIterations
)}$`;

// Separate brands prevent callers from passing a password hash where a salt or
// read user is required.
export const readPasswordHashSchema = z
	.string()
	.refine(
		(value) =>
			/^[0-9a-f]{64}$/u.test(value) ||
			(value.startsWith(readPasswordKdfPrefix) &&
				/^[A-Za-z0-9_-]{43}$/u.test(value.slice(readPasswordKdfPrefix.length))),
		'unsupported read-password verifier format'
	)
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
 * Creates the versioned PBKDF2 verifier stored for private-read credentials.
 * Changing this format invalidates existing credentials.
 */
export async function hashReadPassword(
	password: string,
	salt: ReadPasswordSalt
): Promise<ReadPasswordHash> {
	const key = await crypto.subtle.importKey(
		'raw',
		textEncoder.encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	);
	const derived = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			hash: 'SHA-256',
			iterations: readPasswordKdfIterations,
			salt: textEncoder.encode(`${readPasswordKdfDomain}\0${salt}`)
		},
		key,
		256
	);

	return readPasswordHashSchema.parse(
		`${readPasswordKdfPrefix}${bytesToBase64Url(new Uint8Array(derived))}`
	);
}

async function legacyReadPasswordHash(
	password: string,
	salt: ReadPasswordSalt
): Promise<string> {
	return sha256HexBytes(
		textEncoder.encode(`${readPasswordHashDomain}\0${salt}\0${password}`)
	);
}

export async function isReadPasswordMatching(
	password: string,
	passwordHash: ReadPasswordHash,
	salt: ReadPasswordSalt
): Promise<boolean> {
	const candidate = passwordHash.startsWith(readPasswordKdfPrefix)
		? await hashReadPassword(password, salt)
		: await legacyReadPasswordHash(password, salt);

	return isConstantTimeEqual(
		candidate,
		passwordHash,
		textEncoder.encode(passwordHash).byteLength
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
