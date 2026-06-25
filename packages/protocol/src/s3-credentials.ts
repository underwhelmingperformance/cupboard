import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// The cache a credential is scoped to, as the stored cache name: a valid named
// cache, or the empty string for the default cache. Validating it rejects a
// credential minted for an unreachable cache (uppercase, over-length, `../`).
const cacheFieldSchema = z.union([z.literal(''), cacheNameSchema]).default('');

export const s3CredentialCreateBodySchema = z.strictObject({
	cache: cacheFieldSchema,
	label: z.string().min(1).max(128),
	// A writable credential carries the upload grant; a read-only one can only
	// substitute from the cache.
	writable: z.boolean().default(true),
	expiresAt: z.iso.datetime().optional()
});
export type ParsedS3CredentialCreateBody = z.output<
	typeof s3CredentialCreateBodySchema
>;

export const s3CredentialCreateResponseSchema = z.strictObject({
	credentialId: z.string(),
	accessKeyId: z.string(),
	// The secret access key is returned only here, at creation.
	secretAccessKey: z.string(),
	cache: z.string(),
	label: z.string(),
	// Whether the credential may upload, as confirmed by the server, not just as
	// requested.
	writable: z.boolean(),
	expiresAt: z.string().optional()
});
export type S3CredentialCreated = z.input<
	typeof s3CredentialCreateResponseSchema
>;

export const s3CredentialSummarySchema = z.strictObject({
	credentialId: z.string(),
	accessKeyId: z.string(),
	cache: z.string(),
	label: z.string(),
	writable: z.boolean(),
	createdAt: z.string(),
	expiresAt: z.string().optional()
});
export type S3CredentialSummary = z.input<typeof s3CredentialSummarySchema>;

export const s3CredentialListResponseSchema = z.strictObject({
	credentials: z.array(s3CredentialSummarySchema)
});
export type S3CredentialListResponse = z.input<
	typeof s3CredentialListResponseSchema
>;

export const s3CredentialRevokeResponseSchema = z.strictObject({
	revoked: z.boolean()
});
export type S3CredentialRevokeResponse = z.input<
	typeof s3CredentialRevokeResponseSchema
>;
