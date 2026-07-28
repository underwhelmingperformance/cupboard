import {
	authKeyIdSchema,
	signingKeyIdSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { isoTimestampSchema } from './scalars.ts';

// A key signs new narinfos (`signing`), is advertised from `/pubkey` while
// clients may still trust it (`publication`), or has been dropped (`absent`).
export const signingKeyStageSchema = z.enum([
	'signing',
	'publication',
	'absent'
]);
export type SigningKeyStage = z.infer<typeof signingKeyStageSchema>;

export const signingKeySummarySchema = z.strictObject({
	id: signingKeyIdSchema,
	publicKey: z.string(),
	stage: signingKeyStageSchema,
	createdAt: isoTimestampSchema
});
export type ParsedSigningKeySummary = z.output<typeof signingKeySummarySchema>;

export const keyListResponseSchema = z.strictObject({
	keys: z.array(signingKeySummarySchema)
});
export type ParsedKeyListResponse = z.output<typeof keyListResponseSchema>;

export const keyRotateResponseSchema = z.strictObject({
	rotated: signingKeySummarySchema,
	keys: z.array(signingKeySummarySchema)
});
export type ParsedKeyRotateResponse = z.output<typeof keyRotateResponseSchema>;

export const keyRetireResponseSchema = z.strictObject({
	id: signingKeyIdSchema,
	stage: signingKeyStageSchema
});
export type ParsedKeyRetireResponse = z.output<typeof keyRetireResponseSchema>;

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

export type SigningKeySummary = z.input<typeof signingKeySummarySchema>;
export type KeyListResponse = z.input<typeof keyListResponseSchema>;
export type KeyRotateResponse = z.input<typeof keyRotateResponseSchema>;
export type KeyRetireResponse = z.input<typeof keyRetireResponseSchema>;
export type AuthKeySummary = z.input<typeof authKeySummarySchema>;
export type AuthKeyListResponse = z.input<typeof authKeyListResponseSchema>;
export type AuthKeyRotateResponse = z.input<typeof authKeyRotateResponseSchema>;
export type AuthKeyRetireResponse = z.input<typeof authKeyRetireResponseSchema>;
