import { storePathSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

export const cacheMetadataMaxPaths = 32;
export const cacheMetadataMaxRequestBytes = 64 * 1024;
export const cacheMetadataMaxNarInfoBytes = 1024 * 1024;
export const cacheMetadataMaxResponseBytes = 4 * 1024 * 1024;
export const cacheMetadataMaxCandidateBytes = 8 * 1024 * 1024;
export const cacheMetadataCapabilityHeader = 'x-cupboard-read-capabilities';
export const cacheMetadataCapability = 'path-info-v1';
export const cacheMetadataErrorCodes = {
	requestTooLarge: 'request-too-large',
	narInfoTooLarge: 'narinfo-too-large',
	candidateBudget: 'candidate-budget-exceeded',
	scopeChanged: 'scope-changed',
	narInfoInvalid: 'narinfo-invalid'
} as const;
export const cacheMetadataErrorSchema = z.strictObject({
	code: z.enum(Object.values(cacheMetadataErrorCodes)),
	message: z.string(),
	storePath: storePathSchema.optional()
});
export type CacheMetadataError = z.output<typeof cacheMetadataErrorSchema>;

export const cacheMetadataRequestSchema = z.strictObject({
	storePaths: z
		.array(storePathSchema)
		.min(1)
		.max(cacheMetadataMaxPaths)
		.refine(
			(paths) => new Set(paths).size === paths.length,
			'Each store path must appear once in the metadata page'
		),
	expectedScopeVersion: z.string().min(1).max(128).optional()
});
export type CacheMetadataRequestInput = z.input<
	typeof cacheMetadataRequestSchema
>;
export type CacheMetadataRequest = z.output<typeof cacheMetadataRequestSchema>;

const cacheMetadataEntrySchema = z.discriminatedUnion('status', [
	z.strictObject({
		storePath: storePathSchema,
		status: z.literal('found'),
		narinfo: z
			.string()
			.refine(
				(value) =>
					new TextEncoder().encode(value).byteLength <=
					cacheMetadataMaxNarInfoBytes,
				'Narinfo exceeds the metadata byte limit'
			)
	}),
	z.strictObject({ storePath: storePathSchema, status: z.literal('missing') })
]);
export type CacheMetadataEntry = z.output<typeof cacheMetadataEntrySchema>;

export const cacheMetadataResponseSchema = z
	.strictObject({
		scopeVersion: z.string().min(1).max(128),
		entries: z
			.array(cacheMetadataEntrySchema)
			.min(1)
			.max(cacheMetadataMaxPaths),
		nextIndex: z.number().int().positive().max(cacheMetadataMaxPaths).optional()
	})
	.refine(
		(value) =>
			value.nextIndex === undefined || value.nextIndex === value.entries.length,
		'The continuation must start after the processed prefix'
	);
export type CacheMetadataResponse = z.output<
	typeof cacheMetadataResponseSchema
>;
