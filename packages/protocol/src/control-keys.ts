import { authKeyIdSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { isoTimestampSchema } from './scalars.ts';

// Retired control-plane keys no longer verify tokens. Every other listed key
// remains live, and the newest key issues new tokens.
export const controlKeySummarySchema = z.strictObject({
	kid: authKeyIdSchema,
	retired: z.boolean(),
	scheduledRetireAt: isoTimestampSchema.optional()
});
export type ParsedControlKeySummary = z.output<typeof controlKeySummarySchema>;

export const controlKeyListResponseSchema = z.strictObject({
	keys: z.array(controlKeySummarySchema)
});
export type ParsedControlKeyListResponse = z.output<
	typeof controlKeyListResponseSchema
>;

export const controlKeyRotateResponseSchema = z.strictObject({
	kid: authKeyIdSchema,
	retiring: z
		.strictObject({
			kid: authKeyIdSchema,
			scheduledRetireAt: isoTimestampSchema
		})
		.optional()
});
export type ParsedControlKeyRotateResponse = z.output<
	typeof controlKeyRotateResponseSchema
>;

export const controlKeyRetireResponseSchema = z.strictObject({
	kid: authKeyIdSchema,
	retired: z.boolean()
});
export type ParsedControlKeyRetireResponse = z.output<
	typeof controlKeyRetireResponseSchema
>;

export type ControlKeySummary = z.input<typeof controlKeySummarySchema>;
export type ControlKeyListResponse = z.input<
	typeof controlKeyListResponseSchema
>;
export type ControlKeyRotateResponse = z.input<
	typeof controlKeyRotateResponseSchema
>;
export type ControlKeyRetireResponse = z.input<
	typeof controlKeyRetireResponseSchema
>;
