import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	createPushId,
	isPushIdValid,
	issuePushId,
	pushIdExpiresAtSeconds,
	pushIdNonceSchema,
	pushIdSigningKeySchema
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
