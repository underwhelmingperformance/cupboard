import { z } from 'zod';

import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema
} from './oidc.ts';

// Generic OAuth clients may add fields to this form, so the object remains
// non-strict. `claim_secret` is optional so that a request without it gets the
// same 403 as a request with a wrong one.
export const signupRequestSchema = z.object({
	subject_token: z.string().min(1),
	claim_secret: z.string().optional()
});
export type SignupRequest = z.output<typeof signupRequestSchema>;
export type SignupRequestInput = z.input<typeof signupRequestSchema>;

// The verified principal that the claim seeded. `claimed` is true only when this
// request establishes the global administrator. A repeat by the same verified
// principal succeeds with `false`.
export const signupResponseSchema = z.strictObject({
	issuer: oidcIssuerSchema,
	subject: oidcSubjectSchema,
	audience: oidcAudienceSchema,
	claimed: z.boolean()
});
export type SignupResponse = z.output<typeof signupResponseSchema>;
export type SignupResponseInput = z.input<typeof signupResponseSchema>;
