import {
	positiveIntSchema,
	predicateTypeSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	subrequestSafetyReserve,
	subrequestsPerInvocation
} from './platform.ts';
import { isoTimestampSchema } from './scalars.ts';
import { pushIdSchema, uploadIdSchema } from './upload.ts';

export const attestationDescriptorSchema = z.strictObject({
	digest: sha256HexDigestSchema,
	predicateType: predicateTypeSchema,
	size: positiveIntSchema
});
export type ParsedAttestationDescriptor = z.output<
	typeof attestationDescriptorSchema
>;

export const attestationListSchema = z.strictObject({
	attestations: z.array(attestationDescriptorSchema)
});
export type ParsedAttestationList = z.output<typeof attestationListSchema>;

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
	subrequestsPerInvocation -
	subrequestSafetyReserve -
	attestationNegotiateOverhead;

export const attestationNegotiateRequestSchema = z.strictObject({
	pushId: pushIdSchema,
	bundles: z
		.array(attestationBundleRequestSchema)
		.max(attestationNegotiateMaxBundles)
});
export type ParsedAttestationNegotiateRequest = z.output<
	typeof attestationNegotiateRequestSchema
>;

export const attestationSkipDecisionSchema = z.strictObject({
	action: z.literal('skip'),
	storePathHash: storePathHashSchema,
	digest: sha256HexDigestSchema
});
export type ParsedAttestationSkipDecision = z.output<
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
export type ParsedAttestationUploadDecision = z.output<
	typeof attestationUploadDecisionSchema
>;

export const attestationDecisionSchema = z.discriminatedUnion('action', [
	attestationSkipDecisionSchema,
	attestationUploadDecisionSchema
]);
export type ParsedAttestationDecision = z.output<
	typeof attestationDecisionSchema
>;

export const attestationNegotiateResponseSchema = z.strictObject({
	bundles: z.array(attestationDecisionSchema)
});
export type ParsedAttestationNegotiateResponse = z.output<
	typeof attestationNegotiateResponseSchema
>;

export const attestationAttachResponseSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	digest: sha256HexDigestSchema,
	predicateType: predicateTypeSchema,
	status: z.enum(['attached', 'already-present'])
});
export type ParsedAttestationAttachResponse = z.output<
	typeof attestationAttachResponseSchema
>;

export type AttestationDescriptor = z.input<typeof attestationDescriptorSchema>;
export type AttestationList = z.input<typeof attestationListSchema>;
export type AttestationNegotiateRequest = z.input<
	typeof attestationNegotiateRequestSchema
>;
export type AttestationDecision = z.input<typeof attestationDecisionSchema>;
export type AttestationUploadDecision = z.input<
	typeof attestationUploadDecisionSchema
>;
export type AttestationNegotiateResponse = z.input<
	typeof attestationNegotiateResponseSchema
>;
export type AttestationAttachResponse = z.input<
	typeof attestationAttachResponseSchema
>;
