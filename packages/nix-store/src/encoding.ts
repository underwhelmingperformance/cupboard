/**
 * Encodes bytes with the standard base64 alphabet and `=` padding.
 */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';

	// Passing the whole array to String.fromCodePoint can exceed the engine's
	// argument limit. Append one byte at a time so input length does not affect
	// call arity.
	for (const byte of bytes) {
		binary += String.fromCodePoint(byte);
	}

	return btoa(binary);
}

/**
 * Decodes standard base64 into bytes. `atob` rejects malformed input with a
 * `DOMException`.
 */
export function base64ToBytes(value: string): Uint8Array {
	return Uint8Array.from(
		atob(value),
		(character) => character.codePointAt(0) ?? 0
	);
}

/**
 * Encodes bytes with the URL-safe base64 alphabet and no padding.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64(bytes)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '');
}

/**
 * Encodes bytes as lowercase hexadecimal.
 */
export function bytesToHex(bytes: Uint8Array): string {
	let hex = '';

	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, '0');
	}

	return hex;
}

/**
 * Decodes uppercase or lowercase hexadecimal into bytes. Throws `RangeError`
 * when the input has an odd length or contains a character outside the
 * hexadecimal alphabet.
 */
export function hexToBytes(value: string): Uint8Array {
	if (value.length % 2 !== 0 || /[^\da-f]/iu.test(value)) {
		throw new RangeError(`not a valid hex string: ${value}`);
	}

	const bytes = new Uint8Array(value.length / 2);

	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}

	return bytes;
}
