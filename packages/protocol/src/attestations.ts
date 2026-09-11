import {
	positiveIntSchema,
	predicateTypeSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { subrequestsPerInvocation } from './platform.ts';
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

const attestationBundleRequestSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	digest: sha256HexDigestSchema
});

// The subrequests a negotiate spends other than its per-bundle heads: the D1
// reads for the committed reference edges and for the reference keys already
// filed. Each binds its list as one parameter, so each is one call per bound
// list, and a page produces one list. Two reads is therefore the real cost, and
// the reserve is deliberately far larger so that rearranging them cannot
// overspend it.
const attestationNegotiateOverhead = 50;

/**
 * The bundles one negotiate request carries.
 *
 * A re-run over an unchanged closure sends one bundle for each already-attested
 * path, and the server heads the CAS object of every one it already records. A
 * bundle's digest is the hash of its own document, so no two bundles of a closure
 * share one and deduplicating by digest saves nothing: the cost is one subrequest
 * per bundle.
 *
 * The page size follows from the pinned ceiling, so it moves if the pin moves.
 * A page above the ceiling cannot be served at all: the head that exceeds it
 * throws and the caller gets nothing back, so such a page refuses outright
 * instead of degrading.
 *
 * The CLI chunks at this value, so a closure larger than a page is attested in
 * several pages.
 */
export const attestationNegotiateMaxBundles =
	subrequestsPerInvocation - attestationNegotiateOverhead;

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
