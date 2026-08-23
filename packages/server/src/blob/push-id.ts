// A push ID is a 16-byte random nonce followed by a full HMAC-SHA256 tag, both
// encoded as hexadecimal. The server can verify the ID during negotiation
// without storing per-push state. The domain string prevents the same key from
// authenticating another protocol; changing it invalidates existing push IDs.

import { type PushId, pushIdSchema } from '@cupboard/protocol/upload';
import { z } from 'zod';

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
 * Signs a caller-supplied 16-byte nonce. Callers must provide exactly 16 bytes
 * because verification rejects every other push ID length.
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

export async function createPushId(secret: PushIdSigningKey): Promise<PushId> {
	return issuePushId(
		secret,
		crypto.getRandomValues(new Uint8Array(nonceByteLength))
	);
}

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
