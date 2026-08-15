import { describe, expect, it } from 'vitest';

import {
	createPushId,
	isPushIdValid,
	issuePushId,
	pushIdSigningKeySchema
} from './push-id.ts';

const secret = pushIdSigningKeySchema.parse('parent-secret');
const nonce = Uint8Array.from({ length: 16 }, (_, index) => index);

describe('push id', () => {
	it('issues a hex id whose nonce leads the full HMAC tag', async () => {
		const pushId = await issuePushId(secret, nonce);

		expect({
			length: pushId.length,
			isHex: /^[0-9a-f]+$/.test(pushId),
			nonce: pushId.slice(0, 32)
		}).toStrictEqual({
			length: 96,
			isHex: true,
			nonce: '000102030405060708090a0b0c0d0e0f'
		});
	});

	it('is deterministic for a given secret and nonce', async () => {
		const first = await issuePushId(secret, nonce);
		const second = await issuePushId(secret, nonce);

		expect(first).toBe(second);
	});

	it('accepts an id it signed and rejects tampering, a wrong key and bad shapes', async () => {
		const pushId = await issuePushId(secret, nonce);
		const tamperedTag = `${pushId.slice(0, -1)}${pushId.at(-1) === '0' ? '1' : '0'}`;
		const tamperedNonce = `${pushId.at(0) === '0' ? '1' : '0'}${pushId.slice(1)}`;

		expect({
			genuine: await isPushIdValid(secret, pushId),
			tamperedTag: await isPushIdValid(secret, tamperedTag),
			tamperedNonce: await isPushIdValid(secret, tamperedNonce),
			wrongSecret: await isPushIdValid(
				pushIdSigningKeySchema.parse('other-secret'),
				pushId
			),
			tooShort: await isPushIdValid(secret, pushId.slice(0, -1)),
			notHex: await isPushIdValid(secret, `Z${pushId.slice(1)}`)
		}).toStrictEqual({
			genuine: true,
			tamperedTag: false,
			tamperedNonce: false,
			wrongSecret: false,
			tooShort: false,
			notHex: false
		});
	});

	it('issues random, individually verifiable ids', async () => {
		const first = await createPushId(secret);
		const second = await createPushId(secret);

		expect({
			distinct: first !== second,
			firstValid: await isPushIdValid(secret, first),
			secondValid: await isPushIdValid(secret, second)
		}).toStrictEqual({ distinct: true, firstValid: true, secondValid: true });
	});
});
