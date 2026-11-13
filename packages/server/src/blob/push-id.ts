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

interface PushIdLayout {
	readonly domain: string;
	readonly expiryByteLength: number;
	readonly millisecondsPerExpiryUnit: number;
}

const nonceByteLength = 16;
const hmacByteLength = 32;

// A v2 push ID records its expiry in whole seconds. A v3 push ID records it in
// milliseconds, so the server can tell whether a push started before or after
// a cache removal in the same second. The server issues v3 push IDs and
// accepts both layouts, which have different lengths.
const v2Layout: PushIdLayout = {
	domain: 'cupboard/push-id/v2',
	expiryByteLength: 4,
	millisecondsPerExpiryUnit: 1000
};
const v3Layout: PushIdLayout = {
	domain: 'cupboard/push-id/v3',
	expiryByteLength: 6,
	millisecondsPerExpiryUnit: 1
};

const textEncoder = new TextEncoder();

function layoutLength(layout: PushIdLayout): number {
	return (nonceByteLength + layout.expiryByteLength + hmacByteLength) * 2;
}

function layoutOf(value: string): PushIdLayout | undefined {
	if (!/^[0-9a-f]+$/u.test(value)) {
		return undefined;
	}

	return [v2Layout, v3Layout].find(
		(layout) => layoutLength(layout) === value.length
	);
}

/**
The value as a push ID when it has the length and lowercase hexadecimal
layout of a v2 or v3 push ID.
*/
export function wellFormedPushId(value: string): PushId | undefined {
	if (layoutOf(value) === undefined) {
		return undefined;
	}

	return pushIdSchema.parse(value);
}

/**
The push ID's expiry in milliseconds since the epoch. A v2 push ID gives
whole seconds.
*/
export function pushIdExpiresAtMilliseconds(
	pushId: string
): number | undefined {
	const layout = layoutOf(pushId);
	if (layout === undefined) {
		return undefined;
	}

	const expiryStart = nonceByteLength * 2;
	const expiry = Number.parseInt(
		pushId.slice(expiryStart, expiryStart + layout.expiryByteLength * 2),
		16
	);

	return expiry * layout.millisecondsPerExpiryUnit;
}

export function pushIdExpiresAtSeconds(pushId: string): number | undefined {
	const expiresAtMilliseconds = pushIdExpiresAtMilliseconds(pushId);

	return expiresAtMilliseconds === undefined
		? undefined
		: Math.floor(expiresAtMilliseconds / 1000);
}

/**
Whether the push ID records its expiry in whole seconds.
*/
export function hasSecondPushIdExpiry(pushId: string): boolean {
	return layoutOf(pushId) === v2Layout;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		''
	);
}

export async function importPushIdKey(
	secret: PushIdSigningKey
): Promise<CryptoKey> {
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
	layout: PushIdLayout,
	tenant: TenantId,
	expiryHex: string,
	nonceHex: string
): Promise<string> {
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		textEncoder.encode(`${layout.domain}:${tenant}:${expiryHex}:${nonceHex}`)
	);

	return toHex(new Uint8Array(signature));
}

export const pushIdNonceSchema = z
	.instanceof(Uint8Array)
	.refine((nonce) => nonce.byteLength === nonceByteLength)
	.brand('PushIdNonce');
export type PushIdNonce = z.infer<typeof pushIdNonceSchema>;

async function issueInLayout(
	layout: PushIdLayout,
	secret: PushIdSigningKey,
	tenant: TenantId,
	expiry: number,
	nonce: PushIdNonce
): Promise<PushId> {
	if (
		!Number.isSafeInteger(expiry) ||
		expiry < 0 ||
		expiry > 2 ** (layout.expiryByteLength * 8) - 1
	) {
		throw new RangeError(`Push id expiry does not fit ${layout.domain}`);
	}

	const nonceHex = toHex(nonce);
	const expiryHex = expiry
		.toString(16)
		.padStart(layout.expiryByteLength * 2, '0');

	return pushIdSchema.parse(
		`${nonceHex}${expiryHex}${await tagFor(
			await importPushIdKey(secret),
			layout,
			tenant,
			expiryHex,
			nonceHex
		)}`
	);
}

/**
Signs a v3 push ID over a caller-supplied 16-byte nonce. Callers must provide
exactly 16 bytes because verification rejects every other push ID length.
*/
export async function issuePushId(
	secret: PushIdSigningKey,
	tenant: TenantId,
	expiresAtMilliseconds: number,
	nonce: PushIdNonce
): Promise<PushId> {
	return issueInLayout(v3Layout, secret, tenant, expiresAtMilliseconds, nonce);
}

/**
Signs a v2 push ID, which servers issued before v3. The server accepts it
until it expires.
*/
export async function issueV2PushId(
	secret: PushIdSigningKey,
	tenant: TenantId,
	expiresAtSeconds: number,
	nonce: PushIdNonce
): Promise<PushId> {
	return issueInLayout(v2Layout, secret, tenant, expiresAtSeconds, nonce);
}

/**
Signs a v3 push ID with a fresh random nonce.
*/
export async function createPushId(
	secret: PushIdSigningKey,
	tenant: TenantId,
	expiresAtMilliseconds: number
): Promise<PushId> {
	const random = crypto.getRandomValues(new Uint8Array(nonceByteLength));
	const nonce = pushIdNonceSchema.parse(random);

	return issuePushId(secret, tenant, expiresAtMilliseconds, nonce);
}

/**
Whether the push ID is authentic, belongs to the tenant, and is unexpired.
*/
export async function isPushIdValid(
	secret: PushIdSigningKey,
	pushId: string,
	tenant: TenantId,
	now: Date
): Promise<boolean> {
	const expiresAtMilliseconds = pushIdExpiresAtMilliseconds(pushId);

	if (
		expiresAtMilliseconds === undefined ||
		expiresAtMilliseconds <= now.getTime()
	) {
		return false;
	}

	return hasTenantTag(await importPushIdKey(secret), pushId, tenant);
}

/**
Whether the push ID is authentic and belongs to the tenant, whether or not it
has expired. `key` comes from `importPushIdKey`.
*/
export async function isPushIdIssuedTo(
	key: CryptoKey,
	pushId: PushId,
	tenant: TenantId
): Promise<boolean> {
	return hasTenantTag(key, pushId, tenant);
}

async function hasTenantTag(
	key: CryptoKey,
	pushId: string,
	tenant: TenantId
): Promise<boolean> {
	const layout = layoutOf(pushId);
	if (layout === undefined) {
		return false;
	}

	const nonceHex = pushId.slice(0, nonceByteLength * 2);
	const expiryStart = nonceByteLength * 2;
	const tagStart = expiryStart + layout.expiryByteLength * 2;
	const expiryHex = pushId.slice(expiryStart, tagStart);
	const providedTag = pushId.slice(tagStart);
	const expectedTag = await tagFor(key, layout, tenant, expiryHex, nonceHex);

	return isConstantTimeEqual(providedTag, expectedTag, hmacByteLength * 2);
}
