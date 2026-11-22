import { type AccessKeyId } from '@cupboard/protocol/access-keys';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import { type OidcSubject, type TrustRuleId } from '@cupboard/protocol/oidc';
import { type VerifiedOidcClaims } from '@cupboard/protocol/oidc-trust-match';

import {
	type AccessClaims,
	type AccessTokenClaims,
	writeJwtTtlSeconds
} from './auth.ts';

/**
An access key that the tenant object has verified. The record stays in the
tenant object; a key without `expiresAt` does not expire. `rootIdentity` and
`rootRule` are the identity and trust rule at the root of the key's lineage.
*/
export interface VerifiedAccessKey {
	readonly id: AccessKeyId;
	readonly grants: AuthorizationDetails;
	readonly expiresAt?: Date;
	readonly creatorSubject: OidcSubject;
	readonly rootIdentity: VerifiedOidcClaims;
	readonly rootRule?: TrustRuleId;
}

/**
The verified credential that a request presents: an access token, whose
grants are in the signed claims, or an access key, whose grants are in its
stored record. The control plane has only access tokens, with its own
claims.
*/
export type Principal<Claims extends AccessTokenClaims = AccessClaims> =
	| { readonly kind: 'access-token'; readonly claims: Claims }
	| { readonly kind: 'access-key'; readonly key: VerifiedAccessKey };

export function tokenPrincipal<Claims extends AccessTokenClaims>(
	claims: Claims
): Principal<Claims> {
	return { kind: 'access-token', claims };
}

export function principalGrants(
	principal: Principal<AccessTokenClaims>
): AuthorizationDetails {
	return principal.kind === 'access-token'
		? principal.claims.grants
		: principal.key.grants;
}

/**
The instant at which a principal stops being valid, or undefined for an
access key without an expiry.
*/
export function principalExpiresAt(
	principal: Principal<AccessTokenClaims>
): Date | undefined {
	return principal.kind === 'access-token'
		? principal.claims.expiresAt
		: principal.key.expiresAt;
}

/**
How long work that one request authorises may rely on the principal without
checking it again, such as a commit session or a staging credential. A token
is valid until it expires. A key is checked again after at most the longest
access-token lifetime, so deleting it takes effect within the same time as
revoking a session does.
*/
export function principalAuthorityHorizon(
	principal: Principal<AccessTokenClaims>,
	now: Date
): Date {
	if (principal.kind === 'access-token') {
		return principal.claims.expiresAt;
	}

	const recheckAt = new Date(now.getTime() + writeJwtTtlSeconds * 1000);
	const { expiresAt } = principal.key;

	return expiresAt !== undefined && expiresAt < recheckAt
		? expiresAt
		: recheckAt;
}
