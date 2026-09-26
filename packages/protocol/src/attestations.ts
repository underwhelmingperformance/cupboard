import {
	positiveIntSchema,
	predicateTypeSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	subrequestSafetyReserve,
	workersInvocationAllowances
} from './platform.ts';
import { isoTimestampSchema } from './scalars.ts';
import { pushIdSchema, uploadIdSchema } from './upload.ts';

export const attestationDescriptorSchema = z.strictObject({
	digest: sha256HexDigestSchema,
	predicateType: predicateTypeSchema,
	size: positiveIntSchema
});
export type AttestationDescriptor = z.output<
	typeof attestationDescriptorSchema
>;

export const attestationListSchema = z.strictObject({
	attestations: z.array(attestationDescriptorSchema)
});
export type AttestationList = z.output<typeof attestationListSchema>;

// One R2 head per path, after a D1 lookup that is retried once after a
// transient failure, all within the Free allowance less the safety reserve.
export const attestationStatusMaxPaths =
	workersInvocationAllowances.free.subrequests - subrequestSafetyReserve - 2;

export const attestationStatusRequestSchema = z.strictObject({
	storePathHashes: z.array(storePathHashSchema).max(attestationStatusMaxPaths)
});
export type AttestationStatusRequest = z.output<
	typeof attestationStatusRequestSchema
>;

export const attestationStatusResponseSchema = z.strictObject({
	attestedStorePathHashes: z
		.array(storePathHashSchema)
		.max(attestationStatusMaxPaths)
});
export type AttestationStatusResponse = z.output<
	typeof attestationStatusResponseSchema
>;

const attestationBundleRequestSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	digest: sha256HexDigestSchema
});

// Negotiation makes three D1 calls besides the per-bundle R2 heads: it reads
// committed reference edges, filed reference keys and recorded CAS objects.
// Each page fits in one bound list per read. Keep a margin for changes to
// these reads when calculating the maximum page size.
const attestationNegotiateOverhead = 50;

/**
 * The bundles one negotiate request carries.
 *
 * A re-run over an unchanged closure sends one bundle for each already-attested
 * path. The server heads one CAS object per distinct recorded digest, so the
 * worst case is one subrequest per bundle when every digest differs.
 *
 * The page size follows from the Free allowance and safety reserve.
 * A page above the ceiling cannot be served at all: the head that exceeds it
 * throws and the caller gets nothing back, so such a page refuses outright
 * instead of degrading.
 *
 * The CLI chunks at this value, so a closure larger than a page is attested in
 * several requests.
 */
export const attestationNegotiateMaxBundles =
	workersInvocationAllowances.free.subrequests -
	subrequestSafetyReserve -
	attestationNegotiateOverhead;

export const attestationNegotiateRequestSchema = z.strictObject({
	pushId: pushIdSchema,
	bundles: z
		.array(attestationBundleRequestSchema)
		.max(attestationNegotiateMaxBundles)
});
export type AttestationNegotiateRequest = z.output<
	typeof attestationNegotiateRequestSchema
>;

export const attestationSkipDecisionSchema = z.strictObject({
	action: z.literal('skip'),
	storePathHash: storePathHashSchema,
	digest: sha256HexDigestSchema
});
export type AttestationSkipDecision = z.output<
	typeof attestationSkipDecisionSchema
>;

export const attestationUploadDecisionSchema = z.strictObject({
	action: z.literal('upload'),
	storePathHash: storePathHashSchema,
	digest: sha256HexDigestSchema,
	uploadId: uploadIdSchema,
	r2Key: z.string(),
	expiresAt: isoTimestampSchema
});
export type AttestationUploadDecision = z.output<
	typeof attestationUploadDecisionSchema
>;

export const attestationDecisionSchema = z.discriminatedUnion('action', [
	attestationSkipDecisionSchema,
	attestationUploadDecisionSchema
]);
export type AttestationDecision = z.output<typeof attestationDecisionSchema>;

export const attestationNegotiateResponseSchema = z.strictObject({
	bundles: z.array(attestationDecisionSchema)
});
export type AttestationNegotiateResponse = z.output<
	typeof attestationNegotiateResponseSchema
>;

export const attestationAttachResponseSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	digest: sha256HexDigestSchema,
	predicateType: predicateTypeSchema,
	status: z.enum(['attached', 'already-present'])
});
export type AttestationAttachResponse = z.output<
	typeof attestationAttachResponseSchema
>;

export type AttestationDescriptorInput = z.input<
	typeof attestationDescriptorSchema
>;
export type AttestationListInput = z.input<typeof attestationListSchema>;
export type AttestationNegotiateRequestInput = z.input<
	typeof attestationNegotiateRequestSchema
>;
export type AttestationDecisionInput = z.input<
	typeof attestationDecisionSchema
>;
export type AttestationUploadDecisionInput = z.input<
	typeof attestationUploadDecisionSchema
>;
export type AttestationNegotiateResponseInput = z.input<
	typeof attestationNegotiateResponseSchema
>;
export type AttestationAttachResponseInput = z.input<
	typeof attestationAttachResponseSchema
>;
