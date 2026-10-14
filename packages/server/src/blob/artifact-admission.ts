import { cacheGenerationSchema } from '@cupboard/nix-store/scalars';
import {
	artifactJobVersionSchema,
	artifactTaskIdSchema
} from '@cupboard/protocol/artifact-jobs';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { z } from 'zod';

export const artifactAdmissionIdSchema = z.uuid().brand('ArtifactAdmissionId');
export type ArtifactAdmissionId = z.output<typeof artifactAdmissionIdSchema>;
export const artifactAdmissionSchema = z.strictObject({
	id: artifactAdmissionIdSchema,
	job: artifactJobVersionSchema,
	taskId: artifactTaskIdSchema,
	cacheGeneration: cacheGenerationSchema,
	expiresAt: isoTimestampSchema
});
export type ArtifactAdmission = z.output<typeof artifactAdmissionSchema>;

export const artifactStagingLimits = {
	reservations: 8,
	bytes: 128 * 1024 * 1024
} as const;
