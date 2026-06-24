import { describe, expect, it } from 'vitest';

import {
	base64ToBytes,
	bytesToBase64,
	bytesToBase64Url,
	bytesToHex
} from './encoding.ts';

const bytes = Uint8Array.from([0, 1, 2, 250, 251, 255]);

describe('encoding', () => {
	it('round-trips standard base64', () => {
		expect(base64ToBytes(bytesToBase64(bytes))).toStrictEqual(bytes);
	});

	it('encodes standard base64 with padding', () => {
		expect(bytesToBase64(Uint8Array.from([104, 105]))).toBe('aGk=');
	});

	it('encodes url-safe base64 without padding or + and /', () => {
		expect(bytesToBase64Url(Uint8Array.from([251, 255, 191]))).toBe('-_-_');
		expect(bytesToBase64Url(Uint8Array.from([104, 105]))).toBe('aGk');
	});

	it('encodes lowercase hex', () => {
		expect(bytesToHex(bytes)).toBe('000102fafbff');
	});
});
