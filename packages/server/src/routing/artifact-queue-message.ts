import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { artifactJobVersionSchema } from '@cupboard/protocol/artifact-jobs';
import { artifactKinds } from '@cupboard/protocol/artifacts';
import { z } from 'zod';

import { artifactAdmissionSchema } from '../blob/artifact-admission.ts';

const artifactQueueEnvelopeSchema = z.strictObject({
	kind: z.literal('artifact-job'),
	tenant: tenantIdSchema,
	job: artifactJobVersionSchema,
	artifactKind: z.enum(artifactKinds),
	admission: artifactAdmissionSchema.optional()
});
export const artifactQueueMessageSchema = artifactQueueEnvelopeSchema.refine(
	(message) =>
		message.admission === undefined ||
		(message.admission.job.id === message.job.id &&
			message.admission.job.generation === message.job.generation),
	{ message: 'The admission must belong to the queued job generation' }
);
export type ArtifactQueueMessage = z.output<typeof artifactQueueMessageSchema>;
export const artifactQueueHeaderSchema = artifactQueueEnvelopeSchema
	.pick({ kind: true })
	.loose();
