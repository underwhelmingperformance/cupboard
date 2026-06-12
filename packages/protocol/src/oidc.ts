import { positiveIntSchema } from '@cupboard/nix/scalars';
import { z } from 'zod';

import { isAllowedIssuerUrl, IssuerUrl } from './oidc-issuer.ts';

// RFC 8693 token-exchange mints the first cupboard token of a session. The
// subject token is an external OIDC JWT — the owner's `id_token` or a CI GitHub
// Actions token. The issued cupboard token is reported as an access token.
export const tokenExchangeGrantType =
	'urn:ietf:params:oauth:grant-type:token-exchange';
export const issuedAccessTokenType =
	'urn:ietf:params:oauth:token-type:access_token';

// RFC 6749 §6: presenting a refresh token re-issues an access token without a
// fresh external login. A tenant's token endpoint grants one alongside an
// admin exchange and rotates it on every use; the control plane's endpoint
// stays exchange-only.
export const refreshTokenGrantType = 'refresh_token';

// The subject token is a JWT either way. cupboard accepts only these two RFC 8693
// type identifiers and verifies both the same way, rejecting any other type. Its
// callers present an `id_token`; `jwt` is accepted for clients that label a plain
// OIDC JWT with the generic type.
export const subjectTokenTypeIdToken =
	'urn:ietf:params:oauth:token-type:id_token';
export const subjectTokenTypeJwt = 'urn:ietf:params:oauth:token-type:jwt';

// The optional fields RFC 8693 permits (`audience`, `scope`, `resource`, …) are
// accepted and ignored: the matched trust rule alone fixes the issued scope and
// audience, so a non-strict object strips them rather than rejecting the request.
export const tokenExchangeRequestSchema = z.object({
	grant_type: z.string().min(1),
	subject_token: z.string().min(1),
	subject_token_type: z.string().min(1)
});
export type ParsedTokenExchangeRequest = z.output<
	typeof tokenExchangeRequestSchema
>;

// The tenant token endpoint's request, before grant dispatch: only the grant
// type is required here, and each grant validates its own fields afterwards,
// so an unknown grant type answers `unsupported_grant_type` rather than a
// generic schema failure.
export const tokenRequestSchema = z.object({
	grant_type: z.string().min(1),
	subject_token: z.string().min(1).optional(),
	subject_token_type: z.string().min(1).optional(),
	refresh_token: z.string().min(1).optional()
});
export type ParsedTokenRequest = z.output<typeof tokenRequestSchema>;

// The token endpoint's success body (RFC 6749 §5.1 / RFC 8693 §2.2.1). The
// access token is the cupboard JWT; `issued_token_type` is present for the
// token-exchange grant. A `refresh_token` accompanies an admin session and is
// rotated on every refresh. Field names are the OAuth wire spelling.
export const tokenResponseSchema = z.strictObject({
	access_token: z.string(),
	token_type: z.literal('Bearer'),
	expires_in: positiveIntSchema,
	scope: z.string().optional(),
	issued_token_type: z.string().optional(),
	refresh_token: z.string().optional()
});
export type ParsedTokenResponse = z.output<typeof tokenResponseSchema>;

// A trust rule federates an external OIDC identity into a cupboard scope. The
// owner's `admin` rule is seeded from deploy config; `write` rules (CI) are
// managed through the admin API and bind the minted token to `allowedRoots`.
export const oidcTrustScopeSchema = z.enum(['write', 'admin']);
export type OidcTrustScope = z.infer<typeof oidcTrustScopeSchema>;

export const oidcTrustAddBodySchema = z.strictObject({
	issuer: z
		.url()
		.refine(
			isAllowedIssuerUrl,
			'issuer must be an https URL (http only for loopback)'
		)
		.transform((value) => IssuerUrl.parse(value)?.value ?? value),
	audience: z.string().min(1),
	claims: z
		.record(z.string().min(1), z.string())
		.refine(
			(value) => Object.keys(value).length > 0,
			'at least one claim is required to bind the rule'
		),
	allowedRoots: z.array(z.string().min(1))
});
export type ParsedOidcTrustAddBody = z.output<typeof oidcTrustAddBodySchema>;

export const oidcTrustSummarySchema = z.strictObject({
	id: z.string(),
	issuer: z.string(),
	audience: z.string(),
	scope: oidcTrustScopeSchema,
	claims: z.record(z.string(), z.string()),
	allowedRoots: z.array(z.string()),
	disabled: z.boolean()
});
export type ParsedOidcTrustSummary = z.output<typeof oidcTrustSummarySchema>;

export const oidcTrustListResponseSchema = z.strictObject({
	rules: z.array(oidcTrustSummarySchema)
});
export type ParsedOidcTrustListResponse = z.output<
	typeof oidcTrustListResponseSchema
>;

export const oidcTrustRemoveResponseSchema = z.strictObject({
	id: z.string(),
	removed: z.boolean()
});
export type ParsedOidcTrustRemoveResponse = z.output<
	typeof oidcTrustRemoveResponseSchema
>;

export type TokenExchangeRequest = z.input<typeof tokenExchangeRequestSchema>;
export type TokenResponse = z.input<typeof tokenResponseSchema>;
export type OidcTrustAddBody = z.input<typeof oidcTrustAddBodySchema>;
export type OidcTrustSummary = z.input<typeof oidcTrustSummarySchema>;
export type OidcTrustListResponse = z.input<typeof oidcTrustListResponseSchema>;
export type OidcTrustRemoveResponse = z.input<
	typeof oidcTrustRemoveResponseSchema
>;
