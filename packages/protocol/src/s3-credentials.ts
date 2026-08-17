import { creatableCacheNameSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// The stored cache name a credential is scoped to. The empty string selects the
// default cache; all other values must be valid names for a new cache.
const cacheFieldSchema = z
	.union([z.literal(''), creatableCacheNameSchema])
	.default('');

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
	// The server returns the secret only when it creates the credential.
	secretAccessKey: z.string(),
	cache: z.string(),
	label: z.string(),
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
