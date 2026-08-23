import { z } from 'zod';

import { oidcIssuerSchema, oidcSubjectSchema } from './oidc.ts';

// Generic OAuth clients may add fields to this form, so the object remains
// non-strict. Hosted deployments can also require `claim_secret` alongside the
// external OIDC subject token.
export const signupRequestSchema = z.object({
	subject_token: z.string().min(1),
	claim_secret: z.string().optional()
});
export type ParsedSignupRequest = z.output<typeof signupRequestSchema>;
export type SignupRequest = z.input<typeof signupRequestSchema>;

// `claimed` is true only when this request establishes the global administrator.
// A repeat by the same verified principal succeeds with `false`.
export const signupResponseSchema = z.strictObject({
	issuer: oidcIssuerSchema,
	subject: oidcSubjectSchema,
	claimed: z.boolean()
});
export type ParsedSignupResponse = z.output<typeof signupResponseSchema>;
export type SignupResponse = z.input<typeof signupResponseSchema>;
