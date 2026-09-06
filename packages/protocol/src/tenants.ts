import {
	cacheAccessModeSchema,
	cacheScopeSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { readUserInputSchema } from '@cupboard/shared/http';
import { z } from 'zod';

import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema,
	oidcTrustIssuerInputSchema
} from './oidc.ts';
import { isoTimestampSchema } from './scalars.ts';

export const tenantStatusSchema = z.enum([
	'active',
	'suspended',
	'offboarding',
	'offboarded'
]);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

// A read password is 32 random bytes, rendered as 43 base64url characters.
export const readPasswordByteLength = 32;
const readPasswordLength = 43;

export const defaultReadUser = readUserInputSchema.parse('cupboard');

// A read password is generated, never chosen. The control plane stores a
// salted digest of it, so the credential is protected by the password's own
// entropy, and this schema is exact so that all 256 bits stay random.
export const readPasswordSchema = z
	.string()
	.length(readPasswordLength)
	.regex(/^[A-Za-z0-9_-]+$/);

// base64url is visible ASCII and contains no colon, so Basic authentication can
// split the user from the password and netrc can store both unquoted.
// `readUserInputSchema` excludes colons for the same reason.
export const tenantReadCredentialSchema = z.strictObject({
	user: readUserInputSchema,
	password: readPasswordSchema
});
export type TenantReadCredential = z.output<typeof tenantReadCredentialSchema>;

// The caller selects the initial access of the default cache and supplies the
// OIDC identity for the first admin trust rule. A read credential is the
// fallback credential for private caches that have no credential of their own.
export const tenantCreateBodySchema = z.strictObject({
	id: tenantIdSchema,
	defaultCacheAccess: cacheAccessModeSchema,
	ownerIssuer: oidcTrustIssuerInputSchema,
	ownerSubject: z.string().min(1).brand('OidcSubject'),
	ownerAudience: z.string().min(1).brand('OidcAudience'),
	read: tenantReadCredentialSchema.optional(),
	// The quota covers this tenant's unique compressed NAR objects and unique
	// attestation CAS objects. Omission means unlimited storage.
	quotaBytes: z.number().int().nonnegative().optional()
});
export type TenantCreateBody = z.output<typeof tenantCreateBodySchema>;
export type TenantCreateBodyInput = z.input<typeof tenantCreateBodySchema>;

export const tenantSummarySchema = z.strictObject({
	id: tenantIdSchema,
	status: tenantStatusSchema,
	ownerIssuer: oidcIssuerSchema,
	ownerSubject: oidcSubjectSchema,
	ownerAudience: oidcAudienceSchema,
	configVersion: z.number().int(),
	createdAt: isoTimestampSchema
});
export type TenantSummary = z.output<typeof tenantSummarySchema>;
export type TenantSummaryInput = z.input<typeof tenantSummarySchema>;

export const tenantListResponseSchema = z.strictObject({
	tenants: z.array(tenantSummarySchema)
});
export type TenantListResponse = z.output<typeof tenantListResponseSchema>;
export type TenantListResponseInput = z.input<typeof tenantListResponseSchema>;

export const tenantMutateResponseSchema = z.strictObject({
	id: tenantIdSchema,
	status: tenantStatusSchema
});
export type TenantMutateResponse = z.output<typeof tenantMutateResponseSchema>;
export type TenantMutateResponseInput = z.input<
	typeof tenantMutateResponseSchema
>;

// A membership rebuild reasserts every live tenant's marker and reconstructs
// the admission filter from the registry. The response reports how many tenants
// the gate now admits. No tenant data changes.
export const membershipRebuildResponseSchema = z.strictObject({
	tenants: z.number().int().nonnegative()
});
export type MembershipRebuildResponse = z.output<
	typeof membershipRebuildResponseSchema
>;
export type MembershipRebuildResponseInput = z.input<
	typeof membershipRebuildResponseSchema
>;

export const tenantReadCredentialResponseSchema = z.strictObject({
	id: tenantIdSchema,
	hasCredential: z.boolean()
});
export type TenantReadCredentialResponse = z.output<
	typeof tenantReadCredentialResponseSchema
>;
export type TenantReadCredentialResponseInput = z.input<
	typeof tenantReadCredentialResponseSchema
>;

// The result of setting or clearing one cache's read credential. When a private
// cache has no credential of its own, readers authenticate with the tenant
// credential.
export const cacheReadCredentialResponseSchema = z.strictObject({
	id: tenantIdSchema,
	cache: cacheScopeSchema,
	hasCredential: z.boolean()
});
export type CacheReadCredentialResponse = z.output<
	typeof cacheReadCredentialResponseSchema
>;
export type CacheReadCredentialResponseInput = z.input<
	typeof cacheReadCredentialResponseSchema
>;
