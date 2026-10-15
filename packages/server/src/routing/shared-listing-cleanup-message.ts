import { z } from 'zod';

import { artifactStageIdSchema } from '../blob/artifact-staging.ts';
import { sharedListingStageCleanupCursorSchema } from '../blob/shared-listing-staging.ts';

export const sharedListingCleanupSweepSchema = z
	.strictObject({
		kind: z.literal('shared-listing-stage-sweep'),
		through: sharedListingStageCleanupCursorSchema.shape.at,
		after: sharedListingStageCleanupCursorSchema.optional()
	})
	.refine(
		(message) =>
			message.after === undefined || message.after.at <= message.through,
		{
			message: 'The cleanup cursor must not follow the sweep cutoff'
		}
	);
export const sharedListingCleanupMessageSchema = z.union([
	sharedListingCleanupSweepSchema,
	z.strictObject({
		kind: z.literal('shared-listing-stage-cleanup'),
		id: artifactStageIdSchema
	})
]);
export type SharedListingCleanupMessage = z.output<
	typeof sharedListingCleanupMessageSchema
>;
export const sharedListingCleanupHeaderSchema = z.looseObject({
	kind: z.enum(['shared-listing-stage-sweep', 'shared-listing-stage-cleanup'])
});
