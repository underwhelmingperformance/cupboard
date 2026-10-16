import {
	artifactJobVersionSchema,
	artifactTaskIdSchema
} from '@cupboard/protocol/artifact-jobs';
import { z } from 'zod';

const kinds = [
	'shared-listing-dispatch',
	'shared-listing-job',
	'shared-listing-task'
] as const;
export const sharedListingQueueMessageSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal(kinds[0]) }),
	z.strictObject({ kind: z.literal(kinds[1]), job: artifactJobVersionSchema }),
	z.strictObject({
		kind: z.literal(kinds[2]),
		job: artifactJobVersionSchema,
		id: artifactTaskIdSchema
	})
]);
export type SharedListingQueueMessage = z.output<
	typeof sharedListingQueueMessageSchema
>;
export const sharedListingQueueHeaderSchema = z.looseObject({
	kind: z.enum(kinds)
});
