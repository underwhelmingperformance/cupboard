import { z } from 'zod';

import { CliError } from '../errors.ts';

import { decodeJwtPayload } from './jwt.ts';
import type { CachedSession } from './token-store.ts';

/**
 * Who a saved session signs in as, read from its access token. A tenant
 * session's audience is its tenant URL. A deployment (control-plane) session's
 * audience is a client ID instead.
 */
export interface SessionIdentity {
	/**
	The URL of the session's tenant or deployment. It is the token's issuer.
	*/
	readonly url: string;
	readonly kind: 'tenant' | 'deployment';
	/**
	The OIDC subject of the session, if the token has one.
	*/
	readonly subject?: string;
	/**
	The trust rule that let this sign-in through, if the token records it.
	*/
	readonly rule?: string;
	/**
	When the saved access token expires, as an ISO 8601 timestamp.
	*/
	readonly accessTokenExpiresAt?: string;
	/**
	Whether the session has a refresh token, which lets the CLI renew it without
	asking you to sign in again.
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
 * Describes a saved session from its access token's claims. Returns undefined
 * if the token has no issuer.
 *
 * The signature isn't checked. The result is only shown to the person who owns
 * the session, and the server checks the token every time it's used.
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
 * A person's identity, as their identity provider reports it in an ID token.
 * A tenant administrator needs these values to write a trust rule for the
 * person.
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
	 * The token's string claims, except the ones that change at every sign-in.
	 * A trust rule can only match string claims.
	 */
	readonly claims: Readonly<Record<string, string>>;
	/**
	The identity part of a trust rule that matches this person and no one else.
	*/
	readonly rule: {
		readonly issuer: string;
		readonly audience: string;
		readonly claims: { readonly sub: string };
	};
	/**
	Always false, because the token is decoded locally without checking its
	signature.
	*/
	readonly verified: false;
}

// Claims that describe the token itself or change on every sign-in. A rule
// that matched them would stop working the next time you signed in.
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
			"The identity provider's ID token is missing its issuer, audience or " +
				"subject, so cupboard can't show your identity."
		);
		this.name = 'UnreadableIdTokenError';
	}
}

/**
 * Describes the identity in an OIDC ID token, so the person can send it to a
 * tenant administrator. The signature isn't checked. The token came straight
 * from the provider over TLS, and it's only displayed.
 *
 * If the token's audience includes the client ID used for sign-in, the rule's
 * audience is that client ID, because `cupboard login` uses it as the
 * audience. Otherwise the rule uses the token's first audience.
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
