// A push id is a random nonce followed by the HMAC of that nonce, both hex. The
// server issues it when it hands out a push's upload credential and verifies it
// again on negotiate, so a client cannot present a push id the server never
// signed, and the server keeps no per-push state to check it against. The domain
// prefix versions the construction so a future scheme can be told apart.

import { type PushId, pushIdSchema } from '@cupboard/protocol/upload';
import { z } from 'zod';

// The HMAC secret the server signs and checks push ids with, read from the
// PUSH_ID_SIGNING_KEY binding. Branded so a bare string can never stand in for
// the signing key at a call that expects it.
export const pushIdSigningKeySchema = z.string().brand('PushIdSigningKey');
export type PushIdSigningKey = z.infer<typeof pushIdSigningKeySchema>;

const pushIdDomain = 'cupboard/push-id/v1';
const nonceByteLength = 16;
const hmacByteLength = 32;
const pushIdLength = (nonceByteLength + hmacByteLength) * 2;

const textEncoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		''
	);
}

async function hmacKey(secret: PushIdSigningKey): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		textEncoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
}

async function tagFor(key: CryptoKey, nonceHex: string): Promise<string> {
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		textEncoder.encode(`${pushIdDomain}:${nonceHex}`)
	);

	return toHex(new Uint8Array(signature));
}

function isConstantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}

	let difference = 0;

	for (let index = 0; index < a.length; index += 1) {
		difference |= (a.codePointAt(index) ?? 0) ^ (b.codePointAt(index) ?? 0);
	}

	return difference === 0;
}

/**
 * Signs a push id from a caller-supplied nonce. The nonce is a parameter so the
 * issuing service can supply fresh randomness while tests stay deterministic.
 */
export async function issuePushId(
	secret: PushIdSigningKey,
	nonce: Uint8Array
): Promise<PushId> {
	const nonceHex = toHex(nonce);

	return pushIdSchema.parse(
		`${nonceHex}${await tagFor(await hmacKey(secret), nonceHex)}`
	);
}

/**
Signs a push id over a fresh random nonce.
*/
export async function createPushId(secret: PushIdSigningKey): Promise<PushId> {
	return issuePushId(
		secret,
		crypto.getRandomValues(new Uint8Array(nonceByteLength))
	);
}

/**
Whether the push id carries a tag this secret would have produced.
*/
export async function isPushIdValid(
	secret: PushIdSigningKey,
	pushId: string
): Promise<boolean> {
	if (pushId.length !== pushIdLength || !/^[0-9a-f]+$/.test(pushId)) {
		return false;
	}

	const nonceHex = pushId.slice(0, nonceByteLength * 2);
	const providedTag = pushId.slice(nonceByteLength * 2);
	const expectedTag = await tagFor(await hmacKey(secret), nonceHex);

	return isConstantTimeEqual(providedTag, expectedTag);
}
