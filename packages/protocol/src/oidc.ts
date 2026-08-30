import { positiveIntSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { isAnchoredRe2 } from './capture.ts';
import {
	authorizationDetailsSchema,
	capturePatternMaxLength,
	oidcTrustDisplaySchema,
	permittedGrantSchema
} from './grants.ts';
import { IssuerUrl } from './oidc-issuer.ts';

// Issuer, subject, and audience values use separate brands so the compiler
// rejects arguments in the wrong position. These schemas add brands without
// validating the string. Ingress schemas perform validation before stored or
// reflected values reach this layer.
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

// RFC 8693 token exchange issues the first Cupboard token in a session from an
// external OIDC ID token. The response reports it as an access token.
export const tokenExchangeGrantType =
	'urn:ietf:params:oauth:grant-type:token-exchange';
export const issuedAccessTokenType =
	'urn:ietf:params:oauth:token-type:access_token';

// RFC 6749 §6: presenting a refresh token re-issues an access token without a
// fresh external login. A tenant's token endpoint grants one alongside an
// admin exchange and rotates it on every use; the control plane's endpoint
// stays exchange-only.
export const refreshTokenGrantType = 'refresh_token';

// Cupboard's external trust model consumes OIDC ID tokens. A generic JWT type
// does not identify an issuer-specific profile with equivalent validation
// rules, so external callers must use the ID-token type. A self-issued
// Cupboard token uses the access-token type and can enter only attenuation.
export const subjectTokenTypeIdToken =
	'urn:ietf:params:oauth:token-type:id_token';

// The stable Cupboard problem subtypes which distinguish subject-token
// refusals inside OAuth's `invalid_request` error. The server emits these wire
// values and the CLI uses the same schema to decide whether a fresh login can
// resolve the refusal.
export const subjectTokenProblems = {
	invalid: 'subject-token-invalid',
	untrusted: 'subject-token-untrusted',
	claimMismatch: 'subject-token-claim-mismatch'
} as const;

/**
 * The Cupboard problem subtype of a subject-token refusal.
 */
export const subjectTokenProblemSchema = z.enum(subjectTokenProblems);
export type SubjectTokenProblem = z.infer<typeof subjectTokenProblemSchema>;

// A client sends the RFC 9396 `authorization_details` array as a JSON-encoded
// form field. The token service parses and validates it and returns
// `invalid_authorization_details` for malformed or unauthorised values. A
// claim-bound rule must send the field. A rule that permits a wildcard grant
// may omit it and receive that grant.
const requestedAuthorizationDetailsSchema = z.string().min(1);

// These standard RFC 8693 parameters change the target, requested token, or
// acting party. Cupboard cannot ignore them and issue a token with different
// semantics, so their presence makes the request invalid.
const unsupportedTokenParameterSchema = z.never().optional();
const tokenGrantFields = {
	authorization_details: requestedAuthorizationDetailsSchema.optional(),
	resource: unsupportedTokenParameterSchema,
	audience: unsupportedTokenParameterSchema,
	scope: unsupportedTokenParameterSchema,
	requested_token_type: unsupportedTokenParameterSchema,
	actor_token: unsupportedTokenParameterSchema,
	actor_token_type: unsupportedTokenParameterSchema
} satisfies z.ZodRawShape;

// The dispatch envelope validates only the field needed to select a grant. It
// retains every other singleton form field so the selected grant schema can
// validate its own parameters. Unknown grants therefore reach
// `unsupported_grant_type` even when they contain fields which a supported grant
// would reject.
export const tokenRequestSchema = z.looseObject({
	grant_type: z.string().min(1)
});
export type ParsedTokenRequest = z.output<typeof tokenRequestSchema>;

/**
 * The fields to validate after dispatch selects token exchange.
 */
export const tokenExchangeGrantRequestSchema = z.object({
	...tokenGrantFields,
	grant_type: z.literal(tokenExchangeGrantType),
	subject_token: z.string().min(1),
	subject_token_type: z.string().min(1),
	refresh_token: unsupportedTokenParameterSchema
});
export type ParsedTokenExchangeGrantRequest = z.output<
	typeof tokenExchangeGrantRequestSchema
>;

/**
 * The fields to validate after dispatch selects refresh-token rotation.
 */
export const refreshTokenGrantRequestSchema = z.object({
	...tokenGrantFields,
	grant_type: z.literal(refreshTokenGrantType),
	refresh_token: z.string().min(1),
	subject_token: unsupportedTokenParameterSchema,
	subject_token_type: unsupportedTokenParameterSchema
});
export type ParsedRefreshTokenGrantRequest = z.output<
	typeof refreshTokenGrantRequestSchema
>;

// The matched trust rule fixes the issued audience and grants. Optional RFC
// 8693 target and token-type fields are therefore refused until Cupboard can
// implement their semantics rather than silently returning a different token.
export const tokenExchangeRequestSchema = tokenExchangeGrantRequestSchema;
export type ParsedTokenExchangeRequest = z.output<
	typeof tokenExchangeRequestSchema
>;

// The token endpoint's success body (RFC 6749 §5.1 / RFC 8693 §2.2.1). The
// access token is the Cupboard JWT; `issued_token_type` is present for the
// token-exchange grant. A tenant's interactive session receives a refresh token,
// which rotates on every refresh. `authorization_details` (RFC 9396) reports the
// grants the token carries. Field names use the OAuth wire spelling.
export const tokenResponseSchema = z.strictObject({
	access_token: z.string(),
	token_type: z.literal('Bearer'),
	expires_in: positiveIntSchema,
	issued_token_type: z.string().optional(),
	refresh_token: z.string().optional(),
	authorization_details: authorizationDetailsSchema.optional()
});
export type ParsedTokenResponse = z.output<typeof tokenResponseSchema>;

// A trust rule maps an external OIDC identity to Cupboard grants. Deployment
// configuration creates the owner rule with a wildcard grant. Administrators
// create other rules through the API, and their resource bindings determine the
// grants that can be issued. `display` stores provenance for the preset that
// created the rule.
export const oidcTrustIssuerInputSchema = z
	.url()
	.transform((value, context) => {
		const issuer = IssuerUrl.parse(value);

		if (issuer === undefined) {
			context.addIssue({
				code: 'custom',
				message:
					'issuer must be an HTTPS URL without userinfo, a query or a fragment; loopback issuers may use HTTP'
			});
			return z.NEVER;
		}

		return issuer.value;
	})
	.brand('OidcIssuer');

export const oidcTrustAddBodySchema = z.strictObject({
	issuer: oidcTrustIssuerInputSchema,
	audience: z.string().min(1).brand('OidcAudience'),
	claims: z
		.record(z.string().min(1), claimMatchSchema)
		.refine(
			(value) => Object.keys(value).length > 0,
			'at least one claim is required'
		),
	permittedGrants: z.array(permittedGrantSchema).min(1),
	display: oidcTrustDisplaySchema.optional()
});
export type OidcTrustAddBody = z.output<typeof oidcTrustAddBodySchema>;
export type OidcTrustAddBodyInput = z.input<typeof oidcTrustAddBodySchema>;

// Control-plane identities have one stable subject. Patterned subjects cannot
// be represented by the control trust store and would make every row read fail.
export const controlOidcTrustAddBodySchema = oidcTrustAddBodySchema.refine(
	(body) => typeof body.claims.sub === 'string' && body.claims.sub.length > 0,
	{
		message: 'claims.sub must be an exact non-empty string for control trust',
		path: ['claims', 'sub']
	}
);

export const oidcTrustSummarySchema = z.strictObject({
	id: trustRuleIdSchema,
	issuer: oidcIssuerSchema,
	audience: oidcAudienceSchema,
	claims: z.record(z.string(), claimMatchSchema),
	permittedGrants: z.array(permittedGrantSchema),
	display: oidcTrustDisplaySchema.optional(),
	disabled: z.boolean()
});
export type OidcTrustSummary = z.output<typeof oidcTrustSummarySchema>;
export type OidcTrustSummaryInput = z.input<typeof oidcTrustSummarySchema>;

export const oidcTrustListResponseSchema = z.strictObject({
	rules: z.array(oidcTrustSummarySchema)
});
export type OidcTrustListResponse = z.output<
	typeof oidcTrustListResponseSchema
>;

export const oidcTrustRemoveResponseSchema = z.strictObject({
	id: trustRuleIdSchema,
	removed: z.boolean()
});
export type OidcTrustRemoveResponse = z.output<
	typeof oidcTrustRemoveResponseSchema
>;

export type TokenExchangeRequest = z.input<typeof tokenExchangeRequestSchema>;
export type TokenResponse = z.input<typeof tokenResponseSchema>;
