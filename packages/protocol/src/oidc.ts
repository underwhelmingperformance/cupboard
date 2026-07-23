import { positiveIntSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { isAnchoredRe2 } from './capture.ts';
import {
	authorizationDetailsSchema,
	capturePatternMaxLength,
	oidcTrustDisplaySchema,
	permittedGrantSchema
} from './grants.ts';
import { isAllowedIssuerUrl, IssuerUrl } from './oidc-issuer.ts';

// The issuer, subject and audience of an OIDC identity travel together wherever
// trust is configured or matched. Each carries a distinct brand so the compiler
// rejects a call that passes them in the wrong order. Branding is type-level
// only, so these forms parse whatever a live deployment already persisted or
// issued; the ingress schemas that accept a client-supplied value narrow it,
// while these plain forms brand a stored or reflected value without
// re-validating it.
export const oidcIssuerSchema = z.string().brand('OidcIssuer');
export type OidcIssuer = z.infer<typeof oidcIssuerSchema>;

export const oidcSubjectSchema = z.string().brand('OidcSubject');
export type OidcSubject = z.infer<typeof oidcSubjectSchema>;

export const oidcAudienceSchema = z.string().brand('OidcAudience');
export type OidcAudience = z.infer<typeof oidcAudienceSchema>;

// A trust rule's id. The seeded owner rule keeps the literal id `owner`; every
// other rule is created with a random UUID, so the brand does not narrow the
// format. It is type-level only, branding a value the store or a response already
// holds without re-validating it.
export const trustRuleIdSchema = z.string().brand('TrustRuleId');
export type TrustRuleId = z.infer<typeof trustRuleIdSchema>;

// A configured claim is matched either exactly (the token's claim must equal the
// string) or against an anchored RE2 pattern (the claim must match it in full).
// The pattern form lets a rule pin part of a claim and leave the rest open, for
// example a workflow file at any ref.
export const claimMatchSchema = z.union([
	z.string(),
	z.strictObject({
		pattern: z
			.string()
			.min(1)
			.max(capturePatternMaxLength)
			.refine(isAnchoredRe2, 'pattern must be an anchored RE2 expression')
	})
]);
export type ClaimMatch = z.infer<typeof claimMatchSchema>;

// RFC 8693 token-exchange issues the first cupboard token of a session. The
// subject token is an external OIDC JWT: the owner's `id_token` or a CI GitHub
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

// The `authorization_details` a client requests: the RFC 9396 array as a
// JSON-encoded form field, carried as an opaque string here. The token service
// parses and validates it, so a malformed or unpermitted value answers
// `invalid_authorization_details` from the token service. A claim-bound (CI)
// rule must send it; an interactive
// owner may omit it and receive a wildcard.
const requestedAuthorizationDetailsSchema = z.string().min(1);

// The optional fields RFC 8693 permits (`audience`, `scope`, `resource`, …) are
// accepted and ignored: the matched trust rule alone fixes the issued audience,
// so a non-strict object strips them. `authorization_details` is the one
// optional field cupboard reads.
export const tokenExchangeRequestSchema = z.object({
	grant_type: z.string().min(1),
	subject_token: z.string().min(1),
	subject_token_type: z.string().min(1),
	authorization_details: requestedAuthorizationDetailsSchema.optional()
});
export type ParsedTokenExchangeRequest = z.output<
	typeof tokenExchangeRequestSchema
>;

// The tenant token endpoint's request, before grant dispatch: only the grant
// type is required here, and each grant validates its own fields afterwards,
// so an unknown grant type answers `unsupported_grant_type`.
export const tokenRequestSchema = z.object({
	grant_type: z.string().min(1),
	subject_token: z.string().min(1).optional(),
	subject_token_type: z.string().min(1).optional(),
	refresh_token: z.string().min(1).optional(),
	authorization_details: requestedAuthorizationDetailsSchema.optional()
});
export type ParsedTokenRequest = z.output<typeof tokenRequestSchema>;

// The token endpoint's success body (RFC 6749 §5.1 / RFC 8693 §2.2.1). The
// access token is the cupboard JWT; `issued_token_type` is present for the
// token-exchange grant. A `refresh_token` accompanies an interactive session and
// is rotated on every refresh. `authorization_details` (RFC 9396) reports the
// grants the token carries. Field names are the OAuth wire spelling.
export const tokenResponseSchema = z.strictObject({
	access_token: z.string(),
	token_type: z.literal('Bearer'),
	expires_in: positiveIntSchema,
	issued_token_type: z.string().optional(),
	refresh_token: z.string().optional(),
	authorization_details: authorizationDetailsSchema.optional()
});
export type ParsedTokenResponse = z.output<typeof tokenResponseSchema>;

// A trust rule federates an external OIDC identity into a set of cupboard
// grants. The owner's rule is seeded from deploy config with a wildcard grant;
// other rules are managed through the admin API and permit the grants their
// bindings render. `display` carries the human-facing provenance a preset pins.
export const oidcTrustAddBodySchema = z.strictObject({
	issuer: z
		.url()
		.refine(
			isAllowedIssuerUrl,
			'issuer must be an https URL (http only for loopback)'
		)
		.transform((value) => IssuerUrl.parse(value)?.value ?? value)
		.brand('OidcIssuer'),
	audience: z.string().min(1).brand('OidcAudience'),
	claims: z
		.record(z.string().min(1), claimMatchSchema)
		.refine(
			(value) => Object.keys(value).length > 0,
			'at least one claim is required to bind the rule'
		),
	permittedGrants: z.array(permittedGrantSchema).min(1),
	display: oidcTrustDisplaySchema.optional()
});
export type ParsedOidcTrustAddBody = z.output<typeof oidcTrustAddBodySchema>;

export const oidcTrustSummarySchema = z.strictObject({
	id: trustRuleIdSchema,
	issuer: oidcIssuerSchema,
	audience: oidcAudienceSchema,
	claims: z.record(z.string(), claimMatchSchema),
	permittedGrants: z.array(permittedGrantSchema),
	display: oidcTrustDisplaySchema.optional(),
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
	id: trustRuleIdSchema,
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
