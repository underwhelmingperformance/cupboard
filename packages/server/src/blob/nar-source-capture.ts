import { z } from 'zod';

export const narCaptureSequenceSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER)
	.brand('NarCaptureSequence');
export type NarCaptureSequence = z.output<typeof narCaptureSequenceSchema>;

export const narCapturePositionSchema = z
	.strictObject({
		latest: narCaptureSequenceSchema,
		prunedThrough: narCaptureSequenceSchema,
		isReady: z.boolean()
	})
	.refine((position) => position.prunedThrough <= position.latest);
export type NarCapturePosition = z.output<typeof narCapturePositionSchema>;

export const narCaptureWindowSchema = z
	.strictObject({
		after: narCaptureSequenceSchema,
		through: narCaptureSequenceSchema
	})
	.refine((window) => window.after <= window.through);
export type NarCaptureWindow = z.output<typeof narCaptureWindowSchema>;
