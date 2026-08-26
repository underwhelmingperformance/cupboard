import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { readUserInputSchema } from '@cupboard/shared/http';
import { z } from 'zod';

import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema,
	oidcTrustIssuerInputSchema
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
export type ParsedTenantReadCredential = z.output<
	typeof tenantReadCredentialSchema
>;

// The caller selects the read mode and supplies the OIDC identity for the first
// admin trust rule. Deployment onboarding creates its first tenant in public
// mode; `tenant create` defaults to private unless the operator passes
// `--public`. A private tenant may include its read credential. Without one,
// every read fails closed.
export const tenantCreateBodySchema = z.strictObject({
	id: tenantIdSchema,
	readMode: tenantReadModeSchema,
	ownerIssuer: oidcTrustIssuerInputSchema,
	ownerSubject: z.string().min(1).brand('OidcSubject'),
	ownerAudience: z.string().min(1).brand('OidcAudience'),
	read: tenantReadCredentialSchema.optional(),
	// The quota covers this tenant's unique compressed NAR objects and unique
	// attestation CAS objects. Omission means unlimited storage.
	quotaBytes: z.number().int().nonnegative().optional()
});
export type ParsedTenantCreateBody = z.output<typeof tenantCreateBodySchema>;
export type TenantCreateBody = z.input<typeof tenantCreateBodySchema>;

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

export const tenantMutateResponseSchema = z.strictObject({
	id: tenantIdSchema,
	status: tenantStatusSchema
});
export type ParsedTenantMutateResponse = z.output<
	typeof tenantMutateResponseSchema
>;
export type TenantMutateResponse = z.input<typeof tenantMutateResponseSchema>;

// A membership rebuild reasserts every live tenant's marker and reconstructs
// the admission filter from the registry. The response reports how many tenants
// the gate now admits. No tenant data changes.
export const membershipRebuildResponseSchema = z.strictObject({
	tenants: z.number().int().nonnegative()
});
export type ParsedMembershipRebuildResponse = z.output<
	typeof membershipRebuildResponseSchema
>;
export type MembershipRebuildResponse = z.input<
	typeof membershipRebuildResponseSchema
>;

// Read-mode and read-credential mutations return the resulting mode. A read
// credential gates requests only when the tenant is private.
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
