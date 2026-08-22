// A push ID contains a random nonce, an expiry time, and an HMAC tag, all in
// hexadecimal. The tag also covers the tenant. The server verifies these fields
// during negotiation without keeping per-push state. The domain prefix versions
// the construction so the server can distinguish a future format.

import { type TenantId } from '@cupboard/nix-store/scalars';
import { type PushId, pushIdSchema } from '@cupboard/protocol/upload';
import { z } from 'zod';

import { isConstantTimeEqual } from '../crypto/crypto.ts';

// The HMAC key from the PUSH_ID_SIGNING_KEY binding. The brand prevents callers
// from passing an arbitrary string where a signing key is required.
export const pushIdSigningKeySchema = z.string().brand('PushIdSigningKey');
export type PushIdSigningKey = z.infer<typeof pushIdSigningKeySchema>;

const pushIdDomain = 'cupboard/push-id/v2';
const nonceByteLength = 16;
const hmacByteLength = 32;
const expiryByteLength = 4;
const maximumExpirySeconds = 2 ** (expiryByteLength * 8) - 1;
const pushIdLength = (nonceByteLength + expiryByteLength + hmacByteLength) * 2;

const textEncoder = new TextEncoder();

export function pushIdExpiresAtSeconds(pushId: string): number | undefined {
	if (pushId.length !== pushIdLength || !/^[0-9a-f]+$/u.test(pushId)) {
		return undefined;
	}

	const expiryStart = nonceByteLength * 2;
	return Number.parseInt(
		pushId.slice(expiryStart, expiryStart + expiryByteLength * 2),
		16
	);
}

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

async function tagFor(
	key: CryptoKey,
	tenant: TenantId,
	expiryHex: string,
	nonceHex: string
): Promise<string> {
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		textEncoder.encode(`${pushIdDomain}:${tenant}:${expiryHex}:${nonceHex}`)
	);

	return toHex(new Uint8Array(signature));
}

export const pushIdNonceSchema = z
	.instanceof(Uint8Array)
	.refine((nonce) => nonce.byteLength === nonceByteLength)
	.brand('PushIdNonce');
export type PushIdNonce = z.infer<typeof pushIdNonceSchema>;

/**
 * Signs a caller-supplied 16-byte nonce. Callers must provide exactly 16 bytes
 * because verification rejects every other push ID length.
 */
export async function issuePushId(
	secret: PushIdSigningKey,
	tenant: TenantId,
	expiresAtSeconds: number,
	nonce: PushIdNonce
): Promise<PushId> {
	if (
		!Number.isSafeInteger(expiresAtSeconds) ||
		expiresAtSeconds < 0 ||
		expiresAtSeconds > maximumExpirySeconds
	) {
		throw new RangeError('Push id expiry does not fit the v2 format');
	}

	const nonceHex = toHex(nonce);
	const expiryHex = expiresAtSeconds
		.toString(16)
		.padStart(expiryByteLength * 2, '0');

	return pushIdSchema.parse(
		`${nonceHex}${expiryHex}${await tagFor(
			await hmacKey(secret),
			tenant,
			expiryHex,
			nonceHex
		)}`
	);
}

/**
 * Signs a push ID with a fresh random nonce.
 */
export async function createPushId(
	secret: PushIdSigningKey,
	tenant: TenantId,
	expiresAtSeconds: number
): Promise<PushId> {
	const random = crypto.getRandomValues(new Uint8Array(nonceByteLength));
	const nonce = pushIdNonceSchema.parse(random);

	return issuePushId(secret, tenant, expiresAtSeconds, nonce);
}

/**
 * Whether the push ID is authentic, belongs to the tenant, and is unexpired.
 */
export async function isPushIdValid(
	secret: PushIdSigningKey,
	pushId: string,
	tenant: TenantId,
	now: Date
): Promise<boolean> {
	const expiresAtSeconds = pushIdExpiresAtSeconds(pushId);

	if (expiresAtSeconds === undefined) {
		return false;
	}

	if (expiresAtSeconds <= Math.floor(now.getTime() / 1000)) {
		return false;
	}

	const nonceHex = pushId.slice(0, nonceByteLength * 2);
	const expiryStart = nonceByteLength * 2;
	const tagStart = expiryStart + expiryByteLength * 2;
	const expiryHex = pushId.slice(expiryStart, tagStart);
	const providedTag = pushId.slice(tagStart);
	const expectedTag = await tagFor(
		await hmacKey(secret),
		tenant,
		expiryHex,
		nonceHex
	);

	return isConstantTimeEqual(providedTag, expectedTag, hmacByteLength * 2);
}
