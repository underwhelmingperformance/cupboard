import {
	positiveIntSchema,
	predicateTypeSchema,
	sha256HexDigestSchema,
	storePathHashSchema
} from '@cupboard/nix/scalars';
import { z } from 'zod';

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

// One negotiate carries the attestations for a store-path closure, bounded like
// the upload negotiate it accompanies; the cap rejects only an abusive body.
export const attestationNegotiateMaxBundles = 100_000;

export const attestationNegotiateRequestSchema = z.strictObject({
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
	uploadId: z.string(),
	r2Key: z.string(),
	expiresAt: z.string()
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

export const attestationPrepareResponseSchema = z.strictObject({
	uploadUrl: z.string(),
	uploadHeaders: z.record(z.string(), z.string()),
	expiresAt: z.string()
});
export type ParsedAttestationPrepareResponse = z.output<
	typeof attestationPrepareResponseSchema
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
export type AttestationPrepareResponse = z.input<
	typeof attestationPrepareResponseSchema
>;
export type AttestationAttachResponse = z.input<
	typeof attestationAttachResponseSchema
>;
