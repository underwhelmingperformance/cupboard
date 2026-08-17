import {
	nixSha256HashSchema,
	positiveIntSchema,
	referencesSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

const nonNegativeIntSchema = z.number().int().nonnegative();

/**
The S3 credential used for the narinfo PUT that committed a path.
*/
export const s3CommitterSchema = z.strictObject({
	credentialId: z.string(),
	label: z.string()
});

export type S3Committer = z.infer<typeof s3CommitterSchema>;

/**
 * How Cupboard received a committed path. Credential details are redacted when
 * the caller may read the narinfo but may not list S3 credentials.
 */
export const pathOriginSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('native') }),
	z.strictObject({ kind: z.literal('redacted') }),
	z.strictObject({ kind: z.literal('s3'), ...s3CommitterSchema.shape })
]);

export type PathOrigin = z.infer<typeof pathOriginSchema>;

/**
The stored metadata and administrative origin of a committed store path.
*/
export const pathInspectionSchema = z.strictObject({
	cache: z.string(),
	storePathHash: storePathHashSchema,
	storePath: storePathSchema,
	narHash: nixSha256HashSchema,
	narSize: positiveIntSchema,
	references: referencesSchema,
	deriver: storePathSchema.optional(),
	ca: z.string().optional(),
	generation: nonNegativeIntSchema,
	createdAt: z.string(),
	origin: pathOriginSchema
});

export type PathInspection = z.input<typeof pathInspectionSchema>;
export type ParsedPathInspection = z.output<typeof pathInspectionSchema>;
