import { z } from 'zod';

const basicScheme = 'Basic ';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// The Basic-auth user a reader presents, and the value a tenant's stored read
// verifier carries. The brand alone narrows nothing, so a stored value parses
// whatever it holds.
export const readUserSchema = z.string().brand('ReadUser');
export type ReadUser = z.infer<typeof readUserSchema>;

// A user-id as an operator supplies it. The credential is `user:password` split
// on its first colon and RFC 7617 gives the user-id no escape for one, so a name
// carrying a colon cannot be recovered from the header it is rendered into.
export const readUserInputSchema = z
	.string()
	.min(1)
	.refine((value) => !value.includes(':'))
	.brand('ReadUser');

/** The plaintext credential an HTTP Basic header carries. */
export interface BasicCredential {
	readonly user: ReadUser;
	readonly password: string;
}

/** Why an `authorization` header carries no Basic credential. */
export type BasicCredentialRejection =
	'not-basic' | 'undecodable' | 'malformed';

export type BasicCredentialResult =
	| { readonly ok: true; readonly credential: BasicCredential }
	| { readonly ok: false; readonly reason: BasicCredentialRejection };

/**
 * The HTTP Basic `authorization` header for a username and password, encoded as
 * `Basic <base64(user:password)>`. Returned as a header record so a caller can
 * spread it into a `Headers` initialiser or a plain header object. The
 * credential is named rather than positional, so a caller cannot put the
 * password in the username half.
 */
export function basicAuthHeader(credential: BasicCredential): {
	readonly authorization: string;
} {
	const encoded = toBase64(`${credential.user}:${credential.password}`);

	return { authorization: `${basicScheme}${encoded}` };
}

/**
 * The credential an `authorization` header carries, or why it carries none.
 * This is the inverse of {@link basicAuthHeader}: the decoded payload is split
 * on its first colon, so a password may contain colons and a user-id may not.
 */
export function parseBasicAuthHeader(
	header: string | undefined
): BasicCredentialResult {
	if (!header?.startsWith(basicScheme)) {
		return { ok: false, reason: 'not-basic' };
	}

	const decoded = fromBase64(header.slice(basicScheme.length));

	if (decoded === undefined) {
		return { ok: false, reason: 'undecodable' };
	}

	const separator = decoded.indexOf(':');

	if (separator === -1) {
		return { ok: false, reason: 'malformed' };
	}

	const user = readUserInputSchema.safeParse(decoded.slice(0, separator));

	if (!user.success) {
		return { ok: false, reason: 'malformed' };
	}

	return {
		ok: true,
		credential: { user: user.data, password: decoded.slice(separator + 1) }
	};
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

// The bytes a latin1 string stands for, or `undefined` for a character outside
// a byte's range, which no byte string holds.
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
