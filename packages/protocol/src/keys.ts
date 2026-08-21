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
export type ParsedSigningKey = z.output<typeof signingKeySchema>;

export const backfillFailureSchema = z.strictObject({
	operation: z.enum(['resigning', 'cache-purge']),
	failedAt: isoTimestampSchema,
	message: z.string()
});
export type ParsedBackfillFailure = z.output<typeof backfillFailureSchema>;

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
export type ParsedBackfillStatus = z.output<typeof backfillStatusSchema>;

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
export type ParsedSigningKeyEntry = z.output<typeof signingKeyEntrySchema>;

export const keyListResponseSchema = z.strictObject({
	keys: z.array(signingKeyEntrySchema)
});
export type ParsedKeyListResponse = z.output<typeof keyListResponseSchema>;

export const keyRotateResponseSchema = z.strictObject({
	rotated: rotatedSigningKeyEntrySchema,
	keys: z.array(signingKeyEntrySchema)
});
export type ParsedKeyRotateResponse = z.output<typeof keyRotateResponseSchema>;

export const keyRetireResponseSchema = z.strictObject({
	id: signingKeyIdSchema,
	state: z.enum(['published-only', 'absent'])
});
export type ParsedKeyRetireResponse = z.output<typeof keyRetireResponseSchema>;

export const keyAbortResponseSchema = z.strictObject({
	id: signingKeyIdSchema,
	state: z.literal('absent')
});
export type ParsedKeyAbortResponse = z.output<typeof keyAbortResponseSchema>;

// The auth-token signing keys. `active` marks the key that currently issues;
// every listed key still verifies and is published in the JWKS.
export const authKeySummarySchema = z.strictObject({
	kid: authKeyIdSchema,
	createdAt: isoTimestampSchema,
	active: z.boolean(),
	scheduledRetireAt: isoTimestampSchema.optional()
});
export type ParsedAuthKeySummary = z.output<typeof authKeySummarySchema>;

export const authKeyListResponseSchema = z.strictObject({
	keys: z.array(authKeySummarySchema)
});
export type ParsedAuthKeyListResponse = z.output<
	typeof authKeyListResponseSchema
>;

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
export type ParsedAuthKeyRotateResponse = z.output<
	typeof authKeyRotateResponseSchema
>;

export const authKeyRetireResponseSchema = z.strictObject({
	kid: authKeyIdSchema,
	retired: z.boolean()
});
export type ParsedAuthKeyRetireResponse = z.output<
	typeof authKeyRetireResponseSchema
>;

export type SigningKey = z.input<typeof signingKeySchema>;
export type BackfillFailure = z.input<typeof backfillFailureSchema>;
export type BackfillStatus = z.input<typeof backfillStatusSchema>;
export type SigningKeyEntry = z.input<typeof signingKeyEntrySchema>;
export type KeyListResponse = z.input<typeof keyListResponseSchema>;
export type KeyRotateResponse = z.input<typeof keyRotateResponseSchema>;
export type KeyRetireResponse = z.input<typeof keyRetireResponseSchema>;
export type KeyAbortResponse = z.input<typeof keyAbortResponseSchema>;
export type AuthKeySummary = z.input<typeof authKeySummarySchema>;
export type AuthKeyListResponse = z.input<typeof authKeyListResponseSchema>;
export type AuthKeyRotateResponse = z.input<typeof authKeyRotateResponseSchema>;
export type AuthKeyRetireResponse = z.input<typeof authKeyRetireResponseSchema>;
