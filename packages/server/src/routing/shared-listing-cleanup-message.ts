import { nixSha256HashSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { artifactStageIdSchema } from '../blob/artifact-staging.ts';
import { sharedListingOutputCleanupCursorSchema } from '../blob/shared-listing-output-cleanup.ts';
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
const outputSweepSchema = z
	.strictObject({
		kind: z.literal('shared-listing-output-sweep'),
		through: sharedListingOutputCleanupCursorSchema.shape.at,
		after: sharedListingOutputCleanupCursorSchema.optional()
	})
	.refine(
		(message) =>
			message.after === undefined || message.after.at <= message.through,
		{ message: 'The cleanup cursor must not follow the sweep cutoff' }
	);
export const sharedListingCleanupMessageSchema = z.union([
	sharedListingCleanupSweepSchema,
	z.strictObject({
		kind: z.literal('shared-listing-stage-cleanup'),
		id: artifactStageIdSchema
	}),
	outputSweepSchema,
	z.strictObject({
		kind: z.literal('shared-listing-output-cleanup'),
		narHash: nixSha256HashSchema
	})
]);
export type SharedListingCleanupMessage = z.output<
	typeof sharedListingCleanupMessageSchema
>;
export const sharedListingCleanupHeaderSchema = z.looseObject({
	kind: z.enum([
		'shared-listing-stage-sweep',
		'shared-listing-stage-cleanup',
		'shared-listing-output-sweep',
		'shared-listing-output-cleanup'
	])
});
