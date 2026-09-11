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
export type ControlKeySummary = z.output<typeof controlKeySummarySchema>;

export const controlKeyListResponseSchema = z.strictObject({
	keys: z.array(controlKeySummarySchema)
});
export type ControlKeyListResponse = z.output<
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
export type ControlKeyRotateResponse = z.output<
	typeof controlKeyRotateResponseSchema
>;

export const controlKeyRetireResponseSchema = z.strictObject({
	kid: authKeyIdSchema,
	retired: z.boolean()
});
export type ControlKeyRetireResponse = z.output<
	typeof controlKeyRetireResponseSchema
>;

export type ControlKeySummaryInput = z.input<typeof controlKeySummarySchema>;
export type ControlKeyListResponseInput = z.input<
	typeof controlKeyListResponseSchema
>;
export type ControlKeyRotateResponseInput = z.input<
	typeof controlKeyRotateResponseSchema
>;
export type ControlKeyRetireResponseInput = z.input<
	typeof controlKeyRetireResponseSchema
>;
