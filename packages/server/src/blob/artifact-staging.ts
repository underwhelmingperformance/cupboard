import {
	sha256HexDigestSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
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

export function artifactStageObjectKey(tenant: TenantId, id: ArtifactStageId) {
	return r2ObjectKeySchema.parse(`artifact-staging/${tenant}/${id}`);
}
