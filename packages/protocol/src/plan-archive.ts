import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { subjectTokenTypeIdToken } from './oidc.ts';
import { subjectBindingFields } from './subject-binding.ts';

export const planArchiveGrantType =
	'urn:cupboard:params:oauth:grant-type:plan-archive';

export const invalidPlanArchiveTicketProblem = 'invalid-plan-archive-ticket';
export const planArchiveErrorResponseSchema = z.object({
	error: z.string(),
	problem: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,79}$/u)
		.optional()
});

export const planArchiveTicketSchema = z.string().regex(/^v1\.[\da-f]{64}$/u);

export const planArchiveGrantRequestSchema = z.strictObject({
	grant_type: z.literal(planArchiveGrantType),
	subject_token: z.string().min(1),
	subject_token_type: z.literal(subjectTokenTypeIdToken),
	cache: cacheNameSchema.optional(),
	ticket: planArchiveTicketSchema.optional(),
	...subjectBindingFields
});

export type PlanArchiveGrantRequest = z.output<
	typeof planArchiveGrantRequestSchema
>;

export const planArchiveRecipientSchema = z.strictObject({
	ticket: planArchiveTicketSchema,
	recipient: z.string().regex(/^age1[a-z0-9]{58}$/u)
});

export const planArchiveIdentitySchema = z.strictObject({
	identity: z.string().regex(/^AGE-SECRET-KEY-1[A-Z0-9]{58}$/u)
});

export type PlanArchiveIdentity = z.output<typeof planArchiveIdentitySchema>;
export type PlanArchiveRecipient = z.output<typeof planArchiveRecipientSchema>;
