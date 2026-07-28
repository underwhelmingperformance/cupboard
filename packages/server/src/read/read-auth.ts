import { bytesToBase64Url } from '@cupboard/nix-store/encoding';
import { parseBasicAuthHeader, type ReadUser } from '@cupboard/shared/http';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { isConstantTimeEqual, sha256HexBytes } from '../crypto/crypto.ts';

const textEncoder = new TextEncoder();
const readPasswordHashDomain = 'cupboard-read-password-v1';

// The read verifier's remaining fields are otherwise interchangeable strings, so
// each carries its own brand: a hash cannot be handed to a comparison expecting
// a salt, and neither can be handed to one expecting the user.
export const readPasswordHashSchema = z.string().brand('ReadPasswordHash');
export type ReadPasswordHash = z.infer<typeof readPasswordHashSchema>;

export const readPasswordSaltSchema = z.string().brand('ReadPasswordSalt');
export type ReadPasswordSalt = z.infer<typeof readPasswordSaltSchema>;

// A private cache's read verifier: the Basic-auth user and the hash of its
// password. The hash is what the KV admission manifest carries, so the read path
// authorises without a plaintext secret ever leaving the control plane.
export interface ReadVerifier {
	readonly user: ReadUser;
	readonly passwordHash: ReadPasswordHash;
	readonly passwordSalt: ReadPasswordSalt;
}

/** Hashes a read password the same way the verifier stores it, for comparison. */
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
 * Whether a request carries HTTP Basic credentials matching the tenant's read
 * verifier. The user and the password's hash are compared in constant time and
 * unconditionally, so a mismatch in the user does not short-circuit the password
 * comparison.
 */
export async function authoriseRead(
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
