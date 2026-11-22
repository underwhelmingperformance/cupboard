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
A tenant or control-plane sign-in session whose refresh-token family has not
expired. A tenant session created before the server recorded owners has no
issuer, subject or rule until its next renewal. A session also has no rule
when several trust rules together cover its authority.
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

/**
A tenant sign-in session. `accessKeysBelow` counts the stored access keys
below it. `replayedAt` is set when a replayed refresh token ended the session:
it can no longer renew, but it stays listed until it is revoked, or until it
has passed its expiry and no keys remain below it.
*/
export const tenantSessionSummarySchema = refreshSessionSummarySchema.extend({
	accessKeysBelow: z.number().int().nonnegative(),
	replayedAt: isoTimestampSchema.optional()
});
export type TenantSessionSummary = z.output<typeof tenantSessionSummarySchema>;

export const tenantSessionListResponseSchema = z.strictObject({
	sessions: z.array(tenantSessionSummarySchema)
});
export type TenantSessionListResponse = z.output<
	typeof tenantSessionListResponseSchema
>;

/**
The problem of a refresh request that presents a refresh token which another
request has already used, after the retry grace. The server ends the session.
The presenter's token authenticated, so the code tells the presenter only
that the session ended through another use of its family.
*/
export const refreshTokenReplayedProblem = 'refresh-token-replayed';

/**
The outcome of revoking a tenant session. Revoking deletes every access key
below the session, even when the session has already ended.
`deletedAccessKeys` counts those keys, and `revoked` is true when the session
existed or a key was deleted.
*/
export const tenantSessionRevokeResponseSchema =
	refreshSessionRevokeResponseSchema.extend({
		deletedAccessKeys: z.number().int().nonnegative()
	});
export type TenantSessionRevokeResponse = z.output<
	typeof tenantSessionRevokeResponseSchema
>;
