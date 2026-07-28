/** The plaintext credential an HTTP Basic header carries. */
export interface BasicCredential {
	readonly user: string;
	readonly password: string;
}

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
	const encoded = Buffer.from(
		`${credential.user}:${credential.password}`
	).toString('base64');

	return { authorization: `Basic ${encoded}` };
}
