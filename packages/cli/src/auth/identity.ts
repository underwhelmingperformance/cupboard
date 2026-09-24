import { z } from 'zod';

import { CliError } from '../errors.ts';

import { decodeJwtPayload } from './jwt.ts';
import type { CachedSession } from './token-store.ts';

/**
 * Whom a cached session speaks for, read from its access token. A tenant
 * session's audience is its tenant URL; a deployment (control) session's
 * audience is a client id, not a URL.
 */
export interface SessionIdentity {
	/**
	The tenant or deployment URL the session was issued for: the token's issuer.
	*/
	readonly url: string;
	readonly kind: 'tenant' | 'deployment';
	/**
	The OIDC subject the session was issued to, if the token names one.
	*/
	readonly subject?: string;
	/**
	The trust rule that admitted the sign-in, when the token records it.
	*/
	readonly rule?: string;
	/**
	When the cached access token expires, as an ISO 8601 timestamp.
	*/
	readonly accessTokenExpiresAt?: string;
	/**
	Whether the session holds a refresh token, so it can be renewed silently.
	*/
	readonly renewable: boolean;
}

const audienceSchema = z.union([z.string(), z.array(z.string())]);

const sessionClaimsSchema = z.object({
	iss: z.string().min(1),
	aud: audienceSchema.optional(),
	sub: z.string().min(1).optional(),
	exp: z.number().optional(),
	cb_rule: z.string().min(1).optional()
});

/**
 * Describes a cached session from its access token's claims, or returns
 * undefined when the token names no issuer. The claims are decoded without
 * verifying the signature: they only describe the session to its owner, and
 * the server verifies the token whenever it is used.
 */
export function sessionIdentity(
	session: CachedSession
): SessionIdentity | undefined {
	const parsed = sessionClaimsSchema.safeParse(
		decodeJwtPayload(session.accessToken)
	);

	if (!parsed.success) {
		return undefined;
	}

	const claims = parsed.data;
	const audiences = claims.aud === undefined ? [] : [claims.aud].flat();

	return {
		url: claims.iss,
		kind: audiences.includes(claims.iss) ? 'tenant' : 'deployment',
		...(claims.sub !== undefined && { subject: claims.sub }),
		...(claims.cb_rule !== undefined && { rule: claims.cb_rule }),
		...(claims.exp !== undefined && {
			accessTokenExpiresAt: new Date(claims.exp * 1000).toISOString()
		}),
		renewable: session.refreshToken !== undefined
	};
}

/**
 * The identity a trust rule has to match to admit a person: the claims of the
 * ID token their identity provider issued, as a tenant administrator needs them.
 */
export interface ProviderIdentity {
	readonly issuer: string;
	readonly audience: string | readonly string[];
	readonly subject: string;
	/**
	When the ID token expires, as an ISO 8601 timestamp.
	*/
	readonly expiresAt?: string;
	/**
	 * The token's string-valued claims other than those that change with every
	 * sign-in. A trust rule's claims match only string values, so these are the
	 * ones it can name.
	 */
	readonly claims: Readonly<Record<string, string>>;
	/**
	The identity half of a trust rule that matches exactly this person.
	*/
	readonly rule: {
		readonly issuer: string;
		readonly audience: string;
		readonly claims: { readonly sub: string };
	};
	/**
	Always false: the token is decoded locally and its signature not checked.
	*/
	readonly verified: false;
}

// Claims that are the token's envelope or differ on every sign-in, so a rule
// cannot usefully pin them.
const perTokenClaims: ReadonlySet<string> = new Set([
	'iss',
	'aud',
	'exp',
	'iat',
	'nbf',
	'jti',
	'nonce',
	'at_hash',
	'c_hash',
	'auth_time',
	'sid'
]);

const nonEmptyString = z.string().min(1);
const idTokenAudienceSchema = z.union([
	nonEmptyString,
	z.array(nonEmptyString).min(1)
]);

const idTokenClaimsSchema = z
	.object({
		iss: nonEmptyString,
		aud: idTokenAudienceSchema,
		sub: z.string().min(1),
		exp: z.number().optional()
	})
	.catchall(z.unknown());

export class UnreadableIdTokenError extends CliError {
	constructor() {
		super(
			'The identity provider returned an ID token without an issuer, ' +
				'audience and subject, so there is no identity to show.'
		);
		this.name = 'UnreadableIdTokenError';
	}
}

/**
 * Describes the identity in an OIDC ID token, for a person to send to a tenant
 * administrator. The claims are decoded without verifying the signature; the
 * token came straight from the provider over TLS and is only displayed.
 *
 * The rule's audience is the client the person signs in with when the token
 * names it, since that is the audience `cupboard login` will present.
 */
export function providerIdentity(
	idToken: string,
	clientId: string
): ProviderIdentity {
	const parsed = idTokenClaimsSchema.safeParse(decodeJwtPayload(idToken));

	if (!parsed.success) {
		throw new UnreadableIdTokenError();
	}

	const token = parsed.data;
	const audiences: readonly string[] = [token.aud].flat();
	const ruleAudience = audiences.includes(clientId)
		? clientId
		: (audiences[0] ?? clientId);
	const claims = Object.fromEntries(
		Object.entries(token)
			.filter(
				(entry): entry is [string, string] =>
					!perTokenClaims.has(entry[0]) && typeof entry[1] === 'string'
			)
			.toSorted(([left], [right]) => left.localeCompare(right))
	);

	return {
		issuer: token.iss,
		audience: token.aud,
		subject: token.sub,
		...(token.exp !== undefined && {
			expiresAt: new Date(token.exp * 1000).toISOString()
		}),
		claims,
		rule: {
			issuer: token.iss,
			audience: ruleAudience,
			claims: { sub: token.sub }
		},
		verified: false
	};
}
