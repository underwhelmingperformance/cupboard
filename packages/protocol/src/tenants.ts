import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { readUserInputSchema } from '@cupboard/shared/http';
import { z } from 'zod';

import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema
} from './oidc.ts';
import { isoTimestampSchema } from './scalars.ts';

export const tenantReadModeSchema = z.enum(['public', 'private']);
export type TenantReadMode = z.infer<typeof tenantReadModeSchema>;

export const tenantStatusSchema = z.enum([
	'active',
	'suspended',
	'offboarding',
	'offboarded'
]);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

export const readPasswordMinLength = 20;
export const defaultReadUser = 'cupboard';

export const readPasswordSchema = z
	.string()
	.min(readPasswordMinLength)
	.regex(/^[!-~]+$/);

// The Basic-auth credential a private cache requires from a reader. The user is
// one an operator supplies, so it is held to what a Basic header can carry back.
// The password is an opaque secret: the CLI generates one by default, and explicit
// values must be netrc-safe visible ASCII. The control plane hashes it before
// persistence.
export const tenantReadCredentialSchema = z.strictObject({
	user: readUserInputSchema,
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
	ownerIssuer: z.string().min(1).brand('OidcIssuer'),
	ownerSubject: z.string().min(1).brand('OidcSubject'),
	ownerAudience: z.string().min(1).brand('OidcAudience'),
	read: tenantReadCredentialSchema.optional(),
	// The storage quota in bytes; omitted means unlimited. Charged once per tenant
	// per unique NAR hash, so it bounds the tenant's stored compressed bytes.
	quotaBytes: z.number().int().nonnegative().optional()
});
export type ParsedTenantCreateBody = z.output<typeof tenantCreateBodySchema>;
export type TenantCreateBody = z.input<typeof tenantCreateBodySchema>;

// A tenant as the operator admin surface sees it.
export const tenantSummarySchema = z.strictObject({
	id: tenantIdSchema,
	status: tenantStatusSchema,
	readMode: tenantReadModeSchema,
	ownerIssuer: oidcIssuerSchema,
	ownerSubject: oidcSubjectSchema,
	ownerAudience: oidcAudienceSchema,
	configVersion: z.number().int(),
	createdAt: isoTimestampSchema
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

// The body returned by a tenant status mutation (suspend / resume / delete): the
// slug and its resulting status.
export const tenantMutateResponseSchema = z.strictObject({
	id: tenantIdSchema,
	status: tenantStatusSchema
});
export type ParsedTenantMutateResponse = z.output<
	typeof tenantMutateResponseSchema
>;
export type TenantMutateResponse = z.input<typeof tenantMutateResponseSchema>;

// The body returned by a deployment-level membership rebuild: how many live
// tenants the gate now carries. Reasserts every live tenant's marker and
// rebuilds the filter from the registry, so it repairs admission state without
// touching any tenant's data.
export const membershipRebuildResponseSchema = z.strictObject({
	tenants: z.number().int().nonnegative()
});
export type ParsedMembershipRebuildResponse = z.output<
	typeof membershipRebuildResponseSchema
>;
export type MembershipRebuildResponse = z.input<
	typeof membershipRebuildResponseSchema
>;

// The body returned by a readMode or read-credential mutation: the slug and its
// resulting read mode, so the caller can see whether a credential it just set
// actually gates reads (it is moot for a public cache).
export const tenantReadModeResponseSchema = z.strictObject({
	id: tenantIdSchema,
	readMode: tenantReadModeSchema
});
export type ParsedTenantReadModeResponse = z.output<
	typeof tenantReadModeResponseSchema
>;
export type TenantReadModeResponse = z.input<
	typeof tenantReadModeResponseSchema
>;
