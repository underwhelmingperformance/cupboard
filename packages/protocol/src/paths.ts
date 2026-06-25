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
 * The provenance of a direct S3 push: the credential that uploaded the path, by
 * its stable id and tenant-chosen label. Absent for a native CLI push, which
 * authenticates by token rather than S3 credential.
 */
export const uploadOriginSchema = z.strictObject({
	credentialId: z.string(),
	label: z.string()
});

export type UploadOrigin = z.infer<typeof uploadOriginSchema>;

/** A committed store path's narinfo summary, including its ingestion origin. */
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
	origin: uploadOriginSchema.optional()
});

export type PathInspection = z.input<typeof pathInspectionSchema>;
export type ParsedPathInspection = z.output<typeof pathInspectionSchema>;
