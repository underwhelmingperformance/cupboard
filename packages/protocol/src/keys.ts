import {
	authKeyIdSchema,
	signingKeyIdSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { isoTimestampSchema } from './scalars.ts';

export const signingKeySchema = z.strictObject({
	id: signingKeyIdSchema,
	publicKey: z.string(),
	createdAt: isoTimestampSchema
});
export type SigningKey = z.output<typeof signingKeySchema>;

export const backfillFailureSchema = z.strictObject({
	operation: z.enum(['resigning', 'cache-purge']),
	failedAt: isoTimestampSchema,
	message: z.string()
});
export type BackfillFailure = z.output<typeof backfillFailureSchema>;

const runningBackfillSchema = z.strictObject({
	state: z.literal('running'),
	startedAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
	resigned: z.number().int().nonnegative(),
	remaining: z.number().int().nonnegative()
});

const rotatedSigningKeyEntrySchema = z.strictObject({
	state: z.literal('signing'),
	key: signingKeySchema,
	backfill: runningBackfillSchema
});

const retryingBackfillSchema = z.strictObject({
	state: z.literal('retrying'),
	startedAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
	resigned: z.number().int().nonnegative(),
	remaining: z.number().int().nonnegative(),
	failure: backfillFailureSchema
});

const completeBackfillSchema = z.strictObject({
	state: z.literal('complete'),
	startedAt: isoTimestampSchema,
	completedAt: isoTimestampSchema,
	resigned: z.number().int().nonnegative()
});

export const backfillStatusSchema = z.discriminatedUnion('state', [
	runningBackfillSchema,
	retryingBackfillSchema,
	completeBackfillSchema
]);
export type BackfillStatus = z.output<typeof backfillStatusSchema>;

export const signingKeyEntrySchema = z.discriminatedUnion('state', [
	z.strictObject({
		state: z.literal('signing'),
		key: signingKeySchema,
		backfill: backfillStatusSchema.optional()
	}),
	z.strictObject({
		state: z.literal('published-only'),
		key: signingKeySchema
	})
]);
export type SigningKeyEntry = z.output<typeof signingKeyEntrySchema>;

export const keyListResponseSchema = z.strictObject({
	keys: z.array(signingKeyEntrySchema)
});
export type KeyListResponse = z.output<typeof keyListResponseSchema>;

export const keyRotateResponseSchema = z.strictObject({
	rotated: rotatedSigningKeyEntrySchema,
	keys: z.array(signingKeyEntrySchema)
});
export type KeyRotateResponse = z.output<typeof keyRotateResponseSchema>;

export const keyRetireResponseSchema = z.strictObject({
	id: signingKeyIdSchema,
	state: z.enum(['published-only', 'absent'])
});
export type KeyRetireResponse = z.output<typeof keyRetireResponseSchema>;

export const keyAbortResponseSchema = z.strictObject({
	id: signingKeyIdSchema,
	state: z.literal('absent')
});
export type KeyAbortResponse = z.output<typeof keyAbortResponseSchema>;

// `active` marks the key that issues new tokens. Every listed key still
// verifies tokens and remains published in the JWKS.
export const authKeySummarySchema = z.strictObject({
	kid: authKeyIdSchema,
	createdAt: isoTimestampSchema,
	active: z.boolean(),
	scheduledRetireAt: isoTimestampSchema.optional()
});
export type AuthKeySummary = z.output<typeof authKeySummarySchema>;

export const authKeyListResponseSchema = z.strictObject({
	keys: z.array(authKeySummarySchema)
});
export type AuthKeyListResponse = z.output<typeof authKeyListResponseSchema>;

export const authKeyRotateResponseSchema = z.strictObject({
	rotated: authKeyIdSchema,
	retiring: z
		.strictObject({
			kid: authKeyIdSchema,
			scheduledRetireAt: isoTimestampSchema
		})
		.optional(),
	keys: z.array(authKeySummarySchema)
});
export type AuthKeyRotateResponse = z.output<
	typeof authKeyRotateResponseSchema
>;

export const authKeyRetireResponseSchema = z.strictObject({
	kid: authKeyIdSchema,
	retired: z.boolean()
});
export type AuthKeyRetireResponse = z.output<
	typeof authKeyRetireResponseSchema
>;

export type SigningKeyInput = z.input<typeof signingKeySchema>;
export type BackfillFailureInput = z.input<typeof backfillFailureSchema>;
export type BackfillStatusInput = z.input<typeof backfillStatusSchema>;
export type SigningKeyEntryInput = z.input<typeof signingKeyEntrySchema>;
export type KeyListResponseInput = z.input<typeof keyListResponseSchema>;
export type KeyRotateResponseInput = z.input<typeof keyRotateResponseSchema>;
export type KeyRetireResponseInput = z.input<typeof keyRetireResponseSchema>;
export type KeyAbortResponseInput = z.input<typeof keyAbortResponseSchema>;
export type AuthKeySummaryInput = z.input<typeof authKeySummarySchema>;
export type AuthKeyListResponseInput = z.input<
	typeof authKeyListResponseSchema
>;
export type AuthKeyRotateResponseInput = z.input<
	typeof authKeyRotateResponseSchema
>;
export type AuthKeyRetireResponseInput = z.input<
	typeof authKeyRetireResponseSchema
>;
