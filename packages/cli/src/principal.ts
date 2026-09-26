import { z } from 'zod';

import { decodeJwtPayload } from './auth/jwt.ts';

const nameClaim = z.string().trim().min(1).optional().catch(undefined);

const displayClaimsSchema = z.object({
	name: nameClaim,
	email: nameClaim,
	preferred_username: nameClaim,
	sub: nameClaim
});

/**
 * A friendly name for the caller's own identity, taken from the claims of the
 * caller's token: `name`, then `email`, then `preferred_username`, then `sub`.
 * Nothing is stored; the claims are unverified and only shown back to the
 * person who presented them. Undefined when the token contains none.
 */
export function ownDisplayName(token: string): string | undefined {
	const parsed = displayClaimsSchema.safeParse(decodeJwtPayload(token));

	if (!parsed.success) {
		return undefined;
	}

	const claims = parsed.data;

	return claims.name ?? claims.email ?? claims.preferred_username ?? claims.sub;
}

/**
 * How another principal is shown: its full issuer and its subject, such as
 * `https://dash.cloudflare.com · 7c1e2a90-4d3b-4f6e-9a51-0b8c3d2e1f47`. Trust
 * matching compares the full issuer, and two issuers on the same host may
 * differ only in their path, so the label keeps the whole issuer.
 */
export function principalLabel(principal: {
	readonly issuer: string;
	readonly subject: string;
}): string {
	return `${principal.issuer} · ${principal.subject}`;
}
