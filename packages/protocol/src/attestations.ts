import {
	nixSha256HashSchema,
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

export const maxAttestationBundleBytes = 1024 * 1024;

// The media type the cache serves for a stored attestation bundle: a Sigstore
// bundle wrapping the statement's DSSE envelope.
export const attestationBundleMediaType =
	'application/vnd.dev.sigstore.bundle+json';

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

export const attestationInfoCapability = 'attestation-info-v1';
export const attestationInfoMaxPaths = 32;
export const attestationInfoMaxRequestBytes = 64 * 1024;
export const attestationInfoMaxListBytes = 1024 * 1024;
export const attestationInfoMaxResponseBytes = 4 * 1024 * 1024;

export const attestationInfoRequestSchema = z.strictObject({
	storePathHashes: z
		.array(storePathHashSchema)
		.min(1)
		.max(attestationInfoMaxPaths)
		.refine(
			(hashes) => new Set(hashes).size === hashes.length,
			'Each store path hash must appear once in the discovery page'
		),
	predicateTypes: z
		.array(
			predicateTypeSchema.refine(
				(value) => URL.canParse(value),
				'Predicate filters must be absolute URIs'
			)
		)
		.min(1)
		.optional(),
	expectedScopeVersion: z.string().min(1).max(128).optional()
});
export type AttestationInfoRequest = z.output<
	typeof attestationInfoRequestSchema
>;

const attestationInfoEntrySchema = z.discriminatedUnion('status', [
	z.strictObject({
		storePathHash: storePathHashSchema,
		status: z.literal('missing')
	}),
	z.strictObject({
		storePathHash: storePathHashSchema,
		status: z.literal('found'),
		narHash: nixSha256HashSchema,
		attestations: z.array(attestationDescriptorSchema)
	})
]);
export type AttestationInfoEntry = z.output<typeof attestationInfoEntrySchema>;
export const attestationInfoResponseSchema = z
	.strictObject({
		scopeVersion: z.string().min(1).max(128),
		entries: z
			.array(attestationInfoEntrySchema)
			.min(1)
			.max(attestationInfoMaxPaths),
		nextIndex: z
			.number()
			.int()
			.positive()
			.max(attestationInfoMaxPaths)
			.optional()
	})
	.refine(
		(value) =>
			value.nextIndex === undefined || value.nextIndex === value.entries.length,
		'The continuation must start after the processed prefix'
	);
export type AttestationInfoResponse = z.output<
	typeof attestationInfoResponseSchema
>;
export const attestationInfoErrorSchema = z.strictObject({
	code: z.enum([
		'request-too-large',
		'list-too-large',
		'list-invalid',
		'scope-changed'
	]),
	message: z.string(),
	storePathHash: storePathHashSchema.optional()
});
export type AttestationInfoError = z.output<typeof attestationInfoErrorSchema>;

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

// Each path needs a committed-edge read, retried once on failure, three
// reference/charge calls and two list publication calls. The remaining calls
// cover bundle validation and promotion, cache registration and availability
// checks.
export const attestationAttachPathSubrequests = 7;
export const attestationAttachOverheadSubrequests = 30;
export const attestationAttachMaxPaths = Math.floor(
	(workersInvocationAllowances.free.subrequests -
		subrequestSafetyReserve -
		attestationAttachOverheadSubrequests) /
		attestationAttachPathSubrequests
);

// Reuse checks a committed cache reference, reads CAS metadata and copies the
// object to staging. Each distinct digest uses at most five calls.
export const attestationBundleNegotiateMaxBundles = Math.floor(
	(workersInvocationAllowances.free.subrequests -
		subrequestSafetyReserve -
		10) /
		5
);
export const attestationBundleNegotiateRequestSchema = z.strictObject({
	pushId: pushIdSchema,
	bundles: z
		.array(z.strictObject({ digest: sha256HexDigestSchema }))
		.max(attestationBundleNegotiateMaxBundles)
});
export const attestationBundleDecisionSchema = z.discriminatedUnion('action', [
	z.strictObject({
		action: z.literal('upload'),
		digest: sha256HexDigestSchema,
		uploadId: uploadIdSchema,
		r2Key: z.string(),
		expiresAt: isoTimestampSchema
	}),
	z.strictObject({
		action: z.literal('reuse'),
		digest: sha256HexDigestSchema,
		uploadId: uploadIdSchema,
		expiresAt: isoTimestampSchema
	})
]);
export const attestationBundleNegotiateResponseSchema = z.strictObject({
	bundles: z.array(attestationBundleDecisionSchema)
});
export const attestationAttachPathsRequestSchema = z.strictObject({
	id: uploadIdSchema,
	storePathHashes: z
		.array(storePathHashSchema)
		.min(1)
		.max(attestationAttachMaxPaths)
});
const attestationPathOutcomeSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	digest: sha256HexDigestSchema,
	predicateType: predicateTypeSchema,
	status: z.enum(['attached', 'already-present', 'unservable'])
});
export const attestationAttachPathsResponseSchema = z.strictObject({
	paths: z.array(attestationPathOutcomeSchema).max(attestationAttachMaxPaths),
	expiresAt: isoTimestampSchema
});
export type AttestationBundleNegotiateRequest = z.output<
	typeof attestationBundleNegotiateRequestSchema
>;
export type AttestationBundleNegotiateRequestInput = z.input<
	typeof attestationBundleNegotiateRequestSchema
>;
export type AttestationBundleDecisionInput = z.input<
	typeof attestationBundleDecisionSchema
>;
export type AttestationBundleNegotiateResponseInput = z.input<
	typeof attestationBundleNegotiateResponseSchema
>;
export type AttestationAttachPathsResponseInput = z.input<
	typeof attestationAttachPathsResponseSchema
>;
