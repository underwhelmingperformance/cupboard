import {
	sha256HexDigestSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { artifactTaskClaimSchema } from '@cupboard/protocol/artifact-jobs';
import { artifactKinds, maxArtifactBytes } from '@cupboard/protocol/artifacts';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { z } from 'zod';

import { r2ObjectKeySchema } from '../http/http.ts';

export const artifactStageIdSchema = z.uuid().brand('ArtifactStageId');
export type ArtifactStageId = z.output<typeof artifactStageIdSchema>;
export const artifactStageMeasurementSchema = z.strictObject({
	digest: sha256HexDigestSchema,
	size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
});
export type ArtifactStageMeasurement = z.output<
	typeof artifactStageMeasurementSchema
>;

export const artifactStageLeaseSchema = z
	.strictObject({
		id: artifactStageIdSchema,
		key: r2ObjectKeySchema,
		claim: artifactTaskClaimSchema,
		expiresAt: isoTimestampSchema,
		writeUntil: isoTimestampSchema,
		kind: z.enum(artifactKinds),
		maximumBytes: z.number().int().positive().max(maxArtifactBytes.listing),
		cleanupAfter: isoTimestampSchema
	})
	.refine(
		(lease) => lease.maximumBytes <= maxArtifactBytes[lease.kind],
		'The staging byte budget exceeds the artifact kind limit'
	);
export type ArtifactStageLease = z.output<typeof artifactStageLeaseSchema>;
export const artifactMultipartIdSchema = z.string().min(1);

export function artifactStageObjectKey(tenant: TenantId, id: ArtifactStageId) {
	return r2ObjectKeySchema.parse(`artifact-staging/${tenant}/${id}`);
}
