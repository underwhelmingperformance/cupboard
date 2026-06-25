// Byte encoders shared across the workspace. They use `btoa`/`atob`, which are
// available in both Node and workerd, and loop over the bytes rather than
// spreading them into `String.fromCodePoint`, so they are safe for inputs of
// any length.

/** Encode bytes as standard (padded) base64. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';

	for (const byte of bytes) {
		binary += String.fromCodePoint(byte);
	}

	return btoa(binary);
}

/** Decode standard base64 into bytes. */
export function base64ToBytes(value: string): Uint8Array {
	return Uint8Array.from(
		atob(value),
		(character) => character.codePointAt(0) ?? 0
	);
}

/** Encode bytes as URL-safe base64 without padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64(bytes)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '');
}

/** Encode bytes as lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
	let hex = '';

	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, '0');
	}

	return hex;
}

/** Decode a hex string into bytes; throws `RangeError` on malformed input. */
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
