import { storePathSchema } from '@cupboard/nix-store/scalars';
import {
	publicationManifestLeafDigestSchema,
	publicationManifestMaxMembers,
	publicationManifestPageMaxMembers
} from '@cupboard/protocol/publication-manifests';
import { z } from 'zod';

const maximumLeafPages = Math.ceil(
	publicationManifestMaxMembers / publicationManifestPageMaxMembers
);
const lastPathSchema = z.union([z.literal(''), storePathSchema]);

export const captureProgressSchema = z.discriminatedUnion('phase', [
	z.strictObject({
		phase: z.literal('sealing'),
		lastPath: lastPathSchema,
		pageDigests: z
			.array(publicationManifestLeafDigestSchema)
			.max(maximumLeafPages)
	}),
	z.strictObject({ phase: z.literal('publishing'), lastPath: lastPathSchema })
]);

export function captureProgressJson(
	progress: z.input<typeof captureProgressSchema>
): string {
	const validated = captureProgressSchema.parse(progress);
	return JSON.stringify(validated);
}
