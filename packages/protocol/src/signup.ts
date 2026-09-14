import { z } from 'zod';

import { oidcIssuerSchema, oidcSubjectSchema } from './oidc.ts';

// Generic OAuth clients may add fields to this form, so the object remains
// non-strict. Hosted deployments can also require `claim_secret` alongside the
// external OIDC subject token.
export const signupRequestSchema = z.object({
	subject_token: z.string().min(1),
	claim_secret: z.string().optional()
});
export type SignupRequest = z.output<typeof signupRequestSchema>;
export type SignupRequestInput = z.input<typeof signupRequestSchema>;

// `claimed` is true only when this request establishes the global administrator.
// A repeat by the same verified principal succeeds with `false`.
export const signupResponseSchema = z.strictObject({
	issuer: oidcIssuerSchema,
	subject: oidcSubjectSchema,
	claimed: z.boolean()
});
export type SignupResponse = z.output<typeof signupResponseSchema>;
export type SignupResponseInput = z.input<typeof signupResponseSchema>;
