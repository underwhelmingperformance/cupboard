import { z } from 'zod';

import {
	oidcIssuerSchema,
	oidcSubjectSchema,
	trustRuleIdSchema
} from './oidc.ts';
import { isoTimestampSchema } from './scalars.ts';

export const refreshSessionIdSchema = z.uuid().brand('RefreshSessionId');
export type RefreshSessionId = z.output<typeof refreshSessionIdSchema>;

/**
 * A tenant sign-in session whose refresh-token family has not expired. A
 * session created before the server recorded owners has no issuer, subject or
 * rule until its next renewal. A session also has no rule when several trust
 * rules together cover its authority.
 */
export const refreshSessionSummarySchema = z.strictObject({
	id: refreshSessionIdSchema,
	issuer: oidcIssuerSchema.optional(),
	subject: oidcSubjectSchema.optional(),
	rule: trustRuleIdSchema.optional(),
	createdAt: isoTimestampSchema,
	expiresAt: isoTimestampSchema
});
export type RefreshSessionSummary = z.output<
	typeof refreshSessionSummarySchema
>;
export type RefreshSessionSummaryInput = z.input<
	typeof refreshSessionSummarySchema
>;

export const refreshSessionListResponseSchema = z.strictObject({
	sessions: z.array(refreshSessionSummarySchema)
});
export type RefreshSessionListResponse = z.output<
	typeof refreshSessionListResponseSchema
>;
export type RefreshSessionListResponseInput = z.input<
	typeof refreshSessionListResponseSchema
>;

export const refreshSessionRevokeResponseSchema = z.strictObject({
	id: refreshSessionIdSchema,
	revoked: z.boolean()
});
export type RefreshSessionRevokeResponse = z.output<
	typeof refreshSessionRevokeResponseSchema
>;
export type RefreshSessionRevokeResponseInput = z.input<
	typeof refreshSessionRevokeResponseSchema
>;
