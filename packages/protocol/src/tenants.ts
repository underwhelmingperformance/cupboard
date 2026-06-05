import { tenantIdSchema } from '@cupboard/nix/scalars';
import { z } from 'zod';

export const tenantReadModeSchema = z.enum(['public', 'private']);
export const tenantStatusSchema = z.enum([
	'active',
	'suspended',
	'offboarding',
	'offboarded'
]);

export const readPasswordMinLength = 20;
export const defaultReadUser = 'cupboard';

export const readPasswordSchema = z
	.string()
	.min(readPasswordMinLength)
	.regex(/^[!-~]+$/);

// The Basic-auth credential a private cache requires from a reader. The password
// is an opaque secret: the CLI generates one by default, and explicit values must
// be netrc-safe visible ASCII. The control plane hashes it before persistence.
export const tenantReadCredentialSchema = z.strictObject({
	user: z.string().min(1),
	password: readPasswordSchema
});
export type ParsedTenantReadCredential = z.output<
	typeof tenantReadCredentialSchema
>;

// Creating a tenant requires an explicit read mode (private is the hosted default,
// chosen by the caller) and the owner's OIDC identity, which seeds the tenant's
// admin trust. A private cache may carry the read credential that authorises its
// reads; without one a private cache fails closed. A strict object rejects unknown
// fields.
export const tenantCreateBodySchema = z.strictObject({
	id: tenantIdSchema,
	readMode: tenantReadModeSchema,
	ownerIssuer: z.string().min(1),
	ownerSubject: z.string().min(1),
	ownerAudience: z.string().min(1),
	read: tenantReadCredentialSchema.optional(),
	// The storage quota in bytes; omitted means unlimited. Charged once per tenant
	// per unique NAR hash, so it bounds the tenant's stored compressed bytes.
	quotaBytes: z.number().int().nonnegative().optional()
});
export type ParsedTenantCreateBody = z.output<typeof tenantCreateBodySchema>;
export type TenantCreateBody = z.input<typeof tenantCreateBodySchema>;

// A tenant as the operator admin surface sees it.
export const tenantSummarySchema = z.strictObject({
	id: z.string(),
	status: tenantStatusSchema,
	readMode: tenantReadModeSchema,
	ownerIssuer: z.string(),
	ownerSubject: z.string(),
	ownerAudience: z.string(),
	configVersion: z.number().int(),
	createdAt: z.string()
});
export type ParsedTenantSummary = z.output<typeof tenantSummarySchema>;
export type TenantSummary = z.input<typeof tenantSummarySchema>;

export const tenantListResponseSchema = z.strictObject({
	tenants: z.array(tenantSummarySchema)
});
export type ParsedTenantListResponse = z.output<
	typeof tenantListResponseSchema
>;
export type TenantListResponse = z.input<typeof tenantListResponseSchema>;

// The body returned by a tenant status mutation (suspend / delete): the slug and
// its resulting status.
export const tenantMutateResponseSchema = z.strictObject({
	id: z.string(),
	status: tenantStatusSchema
});
export type ParsedTenantMutateResponse = z.output<
	typeof tenantMutateResponseSchema
>;
export type TenantMutateResponse = z.input<typeof tenantMutateResponseSchema>;
