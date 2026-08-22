import { z } from 'zod';

const basicScheme = 'Basic';
const token68Pattern = /^[A-Za-z0-9._~+/-]+=*$/u;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// The Basic-auth user a reader presents, and the user recorded in a tenant's
// stored read verifier. The brand adds no runtime check, so any string parses.
export const readUserSchema = z.string().brand('ReadUser');
export type ReadUser = z.infer<typeof readUserSchema>;

// A user-id as an operator supplies it. The credential is `user:password`,
// split on its first colon, and RFC 7617 gives the user-id no escape for a
// colon of its own. A name containing one could not be recovered from the
// header, so it is refused here.
export const readUserInputSchema = z
	.string()
	.min(1)
	.refine((value) => !value.includes(':') && !hasControlCharacter(value))
	.brand('ReadUser');

export interface BasicCredential {
	readonly user: ReadUser;
	readonly password: string;
}

export type BasicCredentialRejection =
	'not-basic' | 'undecodable' | 'malformed';

export type BasicCredentialResult =
	| { readonly ok: true; readonly credential: BasicCredential }
	| { readonly ok: false; readonly reason: BasicCredentialRejection };

/**
 * Encodes the credential as an HTTP Basic `authorization` header. The returned
 * record can be spread into `HeadersInit` or a plain header object.
 */
export function basicAuthHeader(credential: BasicCredential): {
	readonly authorization: string;
} {
	const encoded = toBase64(`${credential.user}:${credential.password}`);

	return { authorization: `${basicScheme} ${encoded}` };
}

/**
 * Reads token68 credentials from a case-insensitive HTTP authentication
 * scheme. Basic uses token68 directly, and Bearer uses the same character and
 * padding grammar for its b64token. Both schemes require one or more spaces
 * before the credentials.
 */
export function parseAuthenticationHeader(
	header: string | undefined,
	scheme: string
): string | undefined {
	if (header === undefined) {
		return;
	}

	if (hasControlCharacter(header)) {
		return;
	}

	const separator = header.indexOf(' ');

	if (
		separator === -1 ||
		header.slice(0, separator).toLowerCase() !== scheme.toLowerCase()
	) {
		return;
	}

	const credentials = header.slice(separator).replace(/^ +/u, '');

	return token68Pattern.test(credentials) ? credentials : undefined;
}

/**
 * Parses an HTTP Basic credential or returns the reason it was rejected. The
 * decoded value is split at its first colon, so a password may contain colons
 * but a user-id may not.
 */
export function parseBasicAuthHeader(
	header: string | undefined
): BasicCredentialResult {
	const encoded = parseAuthenticationHeader(header, basicScheme);

	if (encoded === undefined) {
		return { ok: false, reason: 'not-basic' };
	}

	const decoded = fromBase64(encoded);

	if (decoded === undefined) {
		return { ok: false, reason: 'undecodable' };
	}

	const separator = decoded.indexOf(':');

	if (separator === -1) {
		return { ok: false, reason: 'malformed' };
	}

	const user = readUserInputSchema.safeParse(decoded.slice(0, separator));
	const password = decoded.slice(separator + 1);

	if (!user.success || hasControlCharacter(password)) {
		return { ok: false, reason: 'malformed' };
	}

	return {
		ok: true,
		credential: { user: user.data, password }
	};
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codePoint = value.codePointAt(index);

		if (codePoint === 0x7f || (codePoint !== undefined && codePoint <= 0x1f)) {
			return true;
		}
	}

	return false;
}

// The header's payload is base64 over the credential's UTF-8 bytes, so both
// halves encode and decode those bytes explicitly; `btoa` and `atob` see a
// string as latin1, one byte per code point.
function toBase64(value: string): string {
	return btoa(String.fromCodePoint(...textEncoder.encode(value)));
}

function fromBase64(value: string): string | undefined {
	let binary: string;

	try {
		binary = atob(value);
	} catch {
		return undefined;
	}

	const bytes = latin1Bytes(binary);

	return bytes === undefined ? undefined : textDecoder.decode(bytes);
}

function latin1Bytes(value: string): Uint8Array | undefined {
	const bytes = new Uint8Array(value.length);

	for (let index = 0; index < value.length; index += 1) {
		const byte = value.codePointAt(index);

		if (byte === undefined || byte > 0xff) {
			return undefined;
		}

		bytes[index] = byte;
	}

	return bytes;
}
