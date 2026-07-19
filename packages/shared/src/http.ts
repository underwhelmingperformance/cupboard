/**
 * The HTTP Basic `authorization` header for a username and password, encoded as
 * `Basic <base64(user:password)>`. Returned as a header record so a caller can
 * spread it into a `Headers` initialiser or a plain header object.
 */
export function basicAuthHeader(
	user: string,
	password: string
): { readonly authorization: string } {
	const encoded = Buffer.from(`${user}:${password}`).toString('base64');

	return { authorization: `Basic ${encoded}` };
}
