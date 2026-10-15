import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { pushIdSchema } from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import {
	createPushId,
	importPushIdKey,
	isPushIdIssuedTo,
	isPushIdValid,
	issuePushId,
	pushIdExpiresAtSeconds,
	pushIdNonceSchema,
	pushIdSigningKeySchema,
	wellFormedPushId
} from './push-id.ts';

const secret = pushIdSigningKeySchema.parse('parent-secret');
const tenant = tenantIdSchema.parse('acme');
const now = new Date('2026-01-01T00:00:00.000Z');
const expiresAtSeconds = Math.floor(now.getTime() / 1000) + 600;
const nonce = pushIdNonceSchema.parse(
	Uint8Array.from({ length: 16 }, (_, index) => index)
);

describe('push IDs', () => {
	it('issues a hexadecimal ID whose nonce precedes the full HMAC tag', async () => {
		const pushId = await issuePushId(secret, tenant, expiresAtSeconds, nonce);

		expect({
			length: pushId.length,
			isHex: /^[0-9a-f]+$/.test(pushId),
			nonce: pushId.slice(0, 32)
		}).toStrictEqual({
			length: 104,
			isHex: true,
			nonce: '000102030405060708090a0b0c0d0e0f'
		});
	});

	it('is deterministic for a given secret and nonce', async () => {
		const first = await issuePushId(secret, tenant, expiresAtSeconds, nonce);
		const second = await issuePushId(secret, tenant, expiresAtSeconds, nonce);

		expect(first).toBe(second);
	});

	it.each([0, 15, 17, 32])('rejects a %i-byte issuance nonce', (length) => {
		expect(pushIdNonceSchema.safeParse(new Uint8Array(length)).success).toBe(
			false
		);
	});

	it.each([-1, 2 ** 32])(
		'rejects an expiry outside the v2 unsigned range: %i',
		async (expiry) => {
			await expect(issuePushId(secret, tenant, expiry, nonce)).rejects.toThrow(
				RangeError
			);
		}
	);

	it.each([0, 2 ** 32 - 1])(
		'encodes an expiry at the v2 unsigned boundary: %i',
		async (expiry) => {
			const pushId = await issuePushId(secret, tenant, expiry, nonce);

			expect(pushIdExpiresAtSeconds(pushId)).toBe(expiry);
		}
	);

	it('accepts an id it signed and rejects tampering, a wrong key and bad shapes', async () => {
		const pushId = await issuePushId(secret, tenant, expiresAtSeconds, nonce);
		const tamperedTag = `${pushId.slice(0, -1)}${pushId.at(-1) === '0' ? '1' : '0'}`;
		const tamperedNonce = `${pushId.at(0) === '0' ? '1' : '0'}${pushId.slice(1)}`;

		expect({
			genuine: await isPushIdValid(secret, pushId, tenant, now),
			tamperedTag: await isPushIdValid(secret, tamperedTag, tenant, now),
			tamperedNonce: await isPushIdValid(secret, tamperedNonce, tenant, now),
			wrongSecret: await isPushIdValid(
				pushIdSigningKeySchema.parse('other-secret'),
				pushId,
				tenant,
				now
			),
			wrongTenant: await isPushIdValid(
				secret,
				pushId,
				tenantIdSchema.parse('beta'),
				now
			),
			expired: await isPushIdValid(
				secret,
				pushId,
				tenant,
				new Date((expiresAtSeconds + 1) * 1000)
			),
			tooShort: await isPushIdValid(secret, pushId.slice(0, -1), tenant, now),
			notHex: await isPushIdValid(secret, `Z${pushId.slice(1)}`, tenant, now)
		}).toStrictEqual({
			genuine: true,
			tamperedTag: false,
			tamperedNonce: false,
			wrongSecret: false,
			wrongTenant: false,
			expired: false,
			tooShort: false,
			notHex: false
		});
	});

	it('attributes an expired ID to its tenant and rejects tampering, a wrong signing key, other tenants and malformed IDs', async () => {
		const key = await importPushIdKey(secret);
		const otherKey = await importPushIdKey(
			pushIdSigningKeySchema.parse('other-secret')
		);
		const expired = await issuePushId(secret, tenant, 0, nonce);
		const tamperedTag = pushIdSchema.parse(
			`${expired.slice(0, -1)}${expired.at(-1) === '0' ? '1' : '0'}`
		);
		const tooShort = pushIdSchema.parse(expired.slice(0, -1));
		const notHex = pushIdSchema.parse(`Z${expired.slice(1)}`);

		expect({
			expired: await isPushIdIssuedTo(key, expired, tenant),
			tamperedTag: await isPushIdIssuedTo(key, tamperedTag, tenant),
			wrongSecret: await isPushIdIssuedTo(otherKey, expired, tenant),
			wrongTenant: await isPushIdIssuedTo(
				key,
				expired,
				tenantIdSchema.parse('beta')
			),
			tooShort: await isPushIdIssuedTo(key, tooShort, tenant),
			notHex: await isPushIdIssuedTo(key, notHex, tenant)
		}).toStrictEqual({
			expired: true,
			tamperedTag: false,
			wrongSecret: false,
			wrongTenant: false,
			tooShort: false,
			notHex: false
		});
	});

	it.each([
		{ name: 'the v2 layout', value: 'a'.repeat(104), isPushId: true },
		{ name: 'a legacy path segment', value: 'attestations', isPushId: false },
		{ name: 'a short value', value: 'a'.repeat(103), isPushId: false },
		{ name: 'uppercase hexadecimal', value: 'A'.repeat(104), isPushId: false },
		{
			name: 'a non-hexadecimal character',
			value: `${'a'.repeat(103)}-`,
			isPushId: false
		}
	])('accepts only the v2 push ID layout: $name', ({ value, isPushId }) => {
		expect(wellFormedPushId(value)).toBe(
			isPushId ? pushIdSchema.parse(value) : undefined
		);
	});

	it('issues random, individually verifiable IDs', async () => {
		const first = await createPushId(secret, tenant, expiresAtSeconds);
		const second = await createPushId(secret, tenant, expiresAtSeconds);

		expect({
			distinct: first !== second,
			firstValid: await isPushIdValid(secret, first, tenant, now),
			secondValid: await isPushIdValid(secret, second, tenant, now)
		}).toStrictEqual({ distinct: true, firstValid: true, secondValid: true });
	});
});
