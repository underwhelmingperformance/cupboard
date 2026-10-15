import { narListingFactSchema } from '@cupboard/protocol/artifacts';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { z } from 'zod';

import { artifactStageIdSchema } from './artifact-staging.ts';
import { sharedListingOutputEpochSchema } from './shared-listing-outputs.ts';
import { sharedListingTaskClaimSchema } from './shared-listing-tasks.ts';

const positiveInteger = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER);

export const sharedListingCompletionIdSchema = z
	.uuid()
	.brand<'SharedListingCompletionId'>();

export type SharedListingCompletionId = z.output<
	typeof sharedListingCompletionIdSchema
>;

export const sharedListingTaskReasonSchema = z.enum([
	'source-unavailable',
	'source-mismatch',
	'unsupported-source',
	'unsupported-generator-revision',
	'resource-limit',
	'generation-failed'
]);

export type SharedListingTaskReason = z.output<
	typeof sharedListingTaskReasonSchema
>;

export const sharedListingCompletionOutputSchema = z.discriminatedUnion(
	'kind',
	[
		z.strictObject({
			kind: z.literal('generated'),
			fact: narListingFactSchema,
			incarnation: positiveInteger,
			stageId: artifactStageIdSchema
		}),
		z.strictObject({
			kind: z.literal('reused'),
			fact: narListingFactSchema,
			incarnation: positiveInteger
		})
	]
);

export type SharedListingCompletionOutput = z.output<
	typeof sharedListingCompletionOutputSchema
>;

export const sharedListingTaskFailureSchema = z.strictObject({
	kind: z.enum(['skipped', 'failed']),
	reason: sharedListingTaskReasonSchema
});

export type SharedListingTaskFailure = z.output<
	typeof sharedListingTaskFailureSchema
>;

const outcomeBase = {
	claim: sharedListingTaskClaimSchema,
	completedAt: isoTimestampSchema
};

const success = {
	fact: narListingFactSchema,
	incarnation: positiveInteger,
	referenceEpoch: sharedListingOutputEpochSchema
};

export const sharedListingTaskOutcomeSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		...outcomeBase,
		...success,
		kind: z.literal('generated'),
		computationGeneration: positiveInteger,
		stageId: artifactStageIdSchema
	}),
	z.strictObject({
		...outcomeBase,
		...success,
		kind: z.literal('reused'),
		computationGeneration: positiveInteger.optional()
	}),
	z.strictObject({
		...outcomeBase,
		kind: z.literal('skipped'),
		reason: sharedListingTaskReasonSchema
	}),
	z.strictObject({
		...outcomeBase,
		kind: z.literal('failed'),
		reason: sharedListingTaskReasonSchema
	})
]);

export type SharedListingTaskOutcome = z.output<
	typeof sharedListingTaskOutcomeSchema
>;

export type SharedListingCompletionResult =
	| {
			readonly kind: 'recorded' | 'already-recorded';
			readonly outcome: SharedListingTaskOutcome;
	  }
	| { readonly kind: 'unavailable' };
