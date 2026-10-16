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

export const artifactAdmissionReservationSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('admitted'),
		admission: artifactAdmissionSchema
	}),
	z.strictObject({ kind: z.literal('capacity'), retryAt: isoTimestampSchema }),
	z.strictObject({ kind: z.literal('unavailable') })
]);
export type ArtifactAdmissionReservation = z.output<
	typeof artifactAdmissionReservationSchema
>;

export const artifactTaskRequeueResultSchema = z.union([
	artifactAdmissionReservationSchema,
	z.strictObject({ kind: z.literal('deferred'), retryAt: isoTimestampSchema })
]);
export type ArtifactTaskRequeueResult = z.output<
	typeof artifactTaskRequeueResultSchema
>;

export const artifactStagingLimits = {
	reservations: 8,
	bytes: 128 * 1024 * 1024
} as const;

export const artifactAdmissionLimits = {
	unstaged: 8,
	total: 8 + artifactStagingLimits.reservations
} as const;
