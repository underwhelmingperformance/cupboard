import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { artifactJobVersionSchema } from '@cupboard/protocol/artifact-jobs';
import { artifactKinds } from '@cupboard/protocol/artifacts';
import { z } from 'zod';

export const artifactQueueMessageSchema = z.strictObject({
	kind: z.literal('artifact-job'),
	tenant: tenantIdSchema,
	job: artifactJobVersionSchema,
	artifactKind: z.enum(artifactKinds)
});
export type ArtifactQueueMessage = z.output<typeof artifactQueueMessageSchema>;
export const artifactQueueHeaderSchema = artifactQueueMessageSchema
	.pick({ kind: true })
	.loose();
