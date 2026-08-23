/**
 * Decodes the unverified payload of a JWT: its middle segment is base64url JSON.
 * Returns undefined when the token has no payload segment or it is not valid
 * JSON. The claims are unverified, so callers must validate anything they read
 * and never trust it for a security decision.
 */
export function decodeJwtPayload(token: string): unknown {
	const segment = token.split('.', 2).at(1);

	if (segment === undefined) {
		return undefined;
	}

	try {
		return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
	} catch {
		return undefined;
	}
}
