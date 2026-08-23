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

export const defaultReadUser = readUserInputSchema.parse('cupboard');

export const readPasswordSchema = z
	.string()
	.min(readPasswordMinLength)
	.regex(/^[!-~]+$/);

// Basic authentication uses the first colon to separate the user from the
// password, so `readUserInputSchema` excludes colons. The CLI generates the
// password by default; explicit values must be visible ASCII that netrc can
// store without escaping. The control plane hashes the password before
// persistence.
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
	ownerIssuer: z.string().min(1).brand('OidcIssuer'),
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
