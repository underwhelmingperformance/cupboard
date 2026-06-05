import { describe, expect, it } from 'vitest';

import { generateAuthKeyPair } from '../auth/auth.ts';
import {
	ControlWrappedKeyMalformedError,
	ControlWrappingKeyInvalidError
} from '../errors.ts';

import {
	unwrapControlPrivateJwk,
	wrapControlPrivateJwk
} from './control-key.ts';

function wrappingKey(): string {
	return btoa(
		String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32)))
	);
}

describe('control key wrapping', () => {
	it('round-trips a private JWK through wrap and unwrap', async () => {
		const key = wrappingKey();
		const { privateJwk } = await generateAuthKeyPair();

		const wrapped = await wrapControlPrivateJwk(key, privateJwk);
		const unwrapped = await unwrapControlPrivateJwk(key, wrapped);

		expect(unwrapped).toStrictEqual(privateJwk);
	});

	it('produces a fresh ciphertext for each wrap of the same key', async () => {
		const key = wrappingKey();
		const { privateJwk } = await generateAuthKeyPair();

		const first = await wrapControlPrivateJwk(key, privateJwk);
		const second = await wrapControlPrivateJwk(key, privateJwk);

		expect(first).not.toBe(second);
		expect(await unwrapControlPrivateJwk(key, first)).toStrictEqual(privateJwk);
		expect(await unwrapControlPrivateJwk(key, second)).toStrictEqual(
			privateJwk
		);
	});

	it('refuses to unwrap with a different wrapping key', async () => {
		const { privateJwk } = await generateAuthKeyPair();
		const wrapped = await wrapControlPrivateJwk(wrappingKey(), privateJwk);

		await expect(
			unwrapControlPrivateJwk(wrappingKey(), wrapped)
		).rejects.toThrow(ControlWrappedKeyMalformedError);
	});

	it('refuses a tampered ciphertext', async () => {
		const key = wrappingKey();
		const { privateJwk } = await generateAuthKeyPair();
		const wrapped = await wrapControlPrivateJwk(key, privateJwk);
		// Flip one base64 character inside the ciphertext (well past the IV and the
		// dot), keeping it valid base64 so GCM authentication is what rejects it.
		const at = Math.floor((wrapped.length * 3) / 4);
		const tampered = `${wrapped.slice(0, at)}${wrapped[at] === 'A' ? 'B' : 'A'}${wrapped.slice(at + 1)}`;

		await expect(unwrapControlPrivateJwk(key, tampered)).rejects.toThrow(
			ControlWrappedKeyMalformedError
		);
	});

	it('refuses a malformed envelope', async () => {
		await expect(
			unwrapControlPrivateJwk(wrappingKey(), 'not-an-envelope')
		).rejects.toThrow(ControlWrappedKeyMalformedError);
	});

	it('rejects a wrapping key that is not 32 bytes', async () => {
		const { privateJwk } = await generateAuthKeyPair();
		const shortKey = btoa(String.fromCodePoint(...new Uint8Array(16)));

		await expect(wrapControlPrivateJwk(shortKey, privateJwk)).rejects.toThrow(
			ControlWrappingKeyInvalidError
		);
	});
});
