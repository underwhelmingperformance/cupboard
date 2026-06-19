import { StatusCodes } from 'http-status-codes';
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
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCodePoint(...bytes));
}

async function unwrapToOutcome(
	promise: Promise<unknown>
): Promise<{ value: unknown } | { error: { name: string; status: number } }> {
	let value: unknown;
	try {
		value = await promise;
	} catch (error_: unknown) {
		expect(error_).toBeInstanceOf(ControlWrappedKeyMalformedError);
		if (!(error_ instanceof ControlWrappedKeyMalformedError)) {
			throw error_;
		}

		return {
			error: {
				name: error_.name,
				status: error_.status
			}
		};
	}

	return { value };
}

async function wrapToOutcome(
	promise: Promise<unknown>
): Promise<
	| { value: unknown }
	| { error: { name: string; status: number; byteLength: number } }
> {
	let value: unknown;
	try {
		value = await promise;
	} catch (error_: unknown) {
		expect(error_).toBeInstanceOf(ControlWrappingKeyInvalidError);
		if (!(error_ instanceof ControlWrappingKeyInvalidError)) {
			throw error_;
		}

		return {
			error: {
				name: error_.name,
				status: error_.status,
				byteLength: error_.byteLength
			}
		};
	}

	return { value };
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

		const outcome = await unwrapToOutcome(
			unwrapControlPrivateJwk(wrappingKey(), wrapped)
		);

		expect(outcome).toStrictEqual({
			error: {
				name: 'ControlWrappedKeyMalformedError',
				status: StatusCodes.INTERNAL_SERVER_ERROR
			}
		});
	});

	it('refuses a tampered ciphertext', async () => {
		const key = wrappingKey();
		const { privateJwk } = await generateAuthKeyPair();
		const wrapped = await wrapControlPrivateJwk(key, privateJwk);
		// Flip one base64 character inside the ciphertext (well past the IV and the
		// dot), keeping it valid base64 so GCM authentication is what rejects it.
		const at = Math.floor((wrapped.length * 3) / 4);
		const tampered = `${wrapped.slice(0, at)}${wrapped[at] === 'A' ? 'B' : 'A'}${wrapped.slice(at + 1)}`;

		const outcome = await unwrapToOutcome(
			unwrapControlPrivateJwk(key, tampered)
		);

		expect(outcome).toStrictEqual({
			error: {
				name: 'ControlWrappedKeyMalformedError',
				status: StatusCodes.INTERNAL_SERVER_ERROR
			}
		});
	});

	it('refuses a malformed envelope', async () => {
		const outcome = await unwrapToOutcome(
			unwrapControlPrivateJwk(wrappingKey(), 'not-an-envelope')
		);

		expect(outcome).toStrictEqual({
			error: {
				name: 'ControlWrappedKeyMalformedError',
				status: StatusCodes.INTERNAL_SERVER_ERROR
			}
		});
	});

	it('rejects a wrapping key that is not 32 bytes', async () => {
		const { privateJwk } = await generateAuthKeyPair();
		const shortKey = btoa(String.fromCodePoint(...new Uint8Array(16)));

		const outcome = await wrapToOutcome(
			wrapControlPrivateJwk(shortKey, privateJwk)
		);

		expect(outcome).toStrictEqual({
			error: {
				name: 'ControlWrappingKeyInvalidError',
				status: StatusCodes.INTERNAL_SERVER_ERROR,
				byteLength: 16
			}
		});
	});
});
