import { z } from 'zod';

import { oidcIssuerSchema, oidcSubjectSchema } from './oidc.ts';

// The bootstrap signup claim. A caller presents an external OIDC subject token and,
// in hosted mode, the deployment's single-use claim secret. A non-strict object
// ignores any extra fields a generic OAuth client might send.
export const signupRequestSchema = z.object({
	subject_token: z.string().min(1),
	claim_secret: z.string().optional()
});
export type ParsedSignupRequest = z.output<typeof signupRequestSchema>;
export type SignupRequest = z.input<typeof signupRequestSchema>;

// The signup success body: the global-admin principal now established, and whether
// this call performed the claim (false for an idempotent re-claim by the same
// principal).
export const signupResponseSchema = z.strictObject({
	issuer: oidcIssuerSchema,
	subject: oidcSubjectSchema,
	claimed: z.boolean()
});
export type ParsedSignupResponse = z.output<typeof signupResponseSchema>;
export type SignupResponse = z.input<typeof signupResponseSchema>;
