import {
	cacheGenerationSchema,
	cacheScopeSchema,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	rootNameSchema,
	sha256HexDigestSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';
import { publicationRequestIdSchema } from './publication-request-id.ts';
import { reuseViewNameSchema, reuseViewRevisionSchema } from './reuse-views.ts';
import { isoTimestampSchema } from './scalars.ts';

export {
	createPublicationRequestId,
	isFreshPublicationRequestId,
	type PublicationRequestId,
	publicationRequestIdSchema
} from './publication-request-id.ts';

export const publicationManifestsCapability = 'publication-manifests-v1';
export const publicationManifestPageMaxMembers = 64;
export const publicationLookupMaxResults = 64;
export const publicationManifestMaxMembers = 100_000;
// The transport must enforce this on raw bytes, including whitespace. Clients
// pack capture pages by bytes as well as by member count.
export const publicationManifestMaxRequestBytes = 64 * 1024;

export const publicationDigestSchema =
	sha256HexDigestSchema.brand('PublicationDigest');
export type PublicationDigest = z.output<typeof publicationDigestSchema>;

// Durable work and caller replay IDs use UUIDs, as do existing upload/session
// identifiers. Separate brands prevent confusing an operation with its request.
export const publicationOperationIdSchema = z
	.uuid()
	.brand('PublicationOperationId');
export type PublicationOperationId = z.output<
	typeof publicationOperationIdSchema
>;

export const publicationPathVersionSchema = z.strictObject({
	storePath: storePathSchema,
	narHash: nixSha256HashSchema,
	generation: narInfoGenerationSchema
});
export type PublicationPathVersion = z.output<
	typeof publicationPathVersionSchema
>;

export const publicationResultIdentitySchema = z.strictObject({
	...publicationPathVersionSchema.shape,
	cache: cacheScopeSchema,
	cacheGeneration: cacheGenerationSchema
});
export type PublicationResultIdentity = z.output<
	typeof publicationResultIdentitySchema
>;

export const publicationMemberSchema = z.strictObject({
	storePath: storePathSchema,
	narHash: nixSha256HashSchema
});
export type PublicationMember = z.output<typeof publicationMemberSchema>;

export const publicationOriginSchema = z.enum([
	'build-selection',
	'legacy-selection'
]);
export type PublicationOrigin = z.output<typeof publicationOriginSchema>;

const memberCountSchema = countSchema.min(1).max(publicationManifestMaxMembers);
export const recordedPublicationSchema = z.strictObject({
	result: publicationResultIdentitySchema,
	digest: publicationDigestSchema,
	memberCount: memberCountSchema,
	origin: publicationOriginSchema
});
export type RecordedPublication = z.output<typeof recordedPublicationSchema>;

// A compact set proves destination materialisation, not this-run execution or
// signing provenance. Counts from several sets can overlap.
export const compactPublicationSetSchema = z.strictObject({
	...recordedPublicationSchema.shape,
	materialisation: z.literal('complete')
});
export type CompactPublicationSet = z.output<
	typeof compactPublicationSetSchema
>;

export const publicationSourceSelectorSchema = z.strictObject({
	view: reuseViewNameSchema,
	expectedRevision: reuseViewRevisionSchema
});
export type PublicationSourceSelector = z.output<
	typeof publicationSourceSelectorSchema
>;

// Lookup resolves expectations against current accepted identities. Capture,
// ensure and response identities retain their mandatory exact generations.
export const publicationLookupTargetSchema = z.strictObject({
	storePath: storePathSchema,
	narHash: nixSha256HashSchema.optional(),
	generation: narInfoGenerationSchema.optional()
});
export type PublicationLookupTarget = z.output<
	typeof publicationLookupTargetSchema
>;

export const publicationLookupSourceSelectorSchema = z.strictObject({
	view: reuseViewNameSchema,
	expectedRevision: reuseViewRevisionSchema.optional()
});
export type PublicationLookupSourceSelector = z.output<
	typeof publicationLookupSourceSelectorSchema
>;

// All routes identify the destination. Cache hints and view selectors never
// confer source authority. The server resolves/fences the view revision and
// arbitrates accepted results as a view read does, without combining NARs.
export const publicationLookupSourceSchema = z
	.strictObject({
		cache: cacheScopeSchema.optional(),
		expectedCacheGeneration: cacheGenerationSchema.optional(),
		selector: publicationLookupSourceSelectorSchema.optional()
	})
	.refine(
		(source) => source.cache !== undefined || source.selector !== undefined,
		'A lookup source requires a concrete cache or a view selector'
	);
export type PublicationLookupSource = z.output<
	typeof publicationLookupSourceSchema
>;

const hasUniqueLookupTargets = (
	targets: readonly PublicationLookupTarget[]
): boolean =>
	new Set(
		targets.map((target) =>
			JSON.stringify([target.storePath, target.narHash, target.generation])
		)
	).size === targets.length;

export const publicationLookupRequestSchema = z.strictObject({
	source: publicationLookupSourceSchema,
	results: z
		.array(publicationLookupTargetSchema)
		.min(1)
		.max(publicationLookupMaxResults)
		.refine(
			hasUniqueLookupTargets,
			'Each target selection must appear once in a lookup'
		)
});
export type PublicationLookupRequest = z.output<
	typeof publicationLookupRequestSchema
>;

export const publicationLookupEntrySchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('recorded'),
		publication: recordedPublicationSchema,
		complete: z.boolean()
	}),
	z.strictObject({
		kind: z.literal('missing'),
		result: publicationResultIdentitySchema
	}),
	z.strictObject({
		kind: z.literal('unavailable'),
		storePath: storePathSchema
	})
]);
export type PublicationLookupEntry = z.output<
	typeof publicationLookupEntrySchema
>;

// One ordered entry per requested result. Missing means an accepted exact
// result lacks an association. Unavailable identifies a bare target with no
// current accepted result. Supplied identity constraints still fence changes;
// permission and provider failures remain errors, never unavailable entries.
export const publicationLookupResponseSchema = z.strictObject({
	entries: z
		.array(publicationLookupEntrySchema)
		.min(1)
		.max(publicationLookupMaxResults),
	// Resolved view revision, suitable for ensure without client inference.
	sourceSelector: publicationSourceSelectorSchema.optional()
});
export type PublicationLookupResponse = z.output<
	typeof publicationLookupResponseSchema
>;

export const publicationCaptureBeginRequestSchema = z.strictObject({
	result: publicationPathVersionSchema,
	expectedCacheGeneration: cacheGenerationSchema,
	requestId: publicationRequestIdSchema,
	origin: publicationOriginSchema,
	memberCount: memberCountSchema
});
export type PublicationCaptureBeginRequest = z.output<
	typeof publicationCaptureBeginRequestSchema
>;

export const publicationCaptureBeginResponseSchema = z.discriminatedUnion(
	'kind',
	[
		z.strictObject({
			kind: z.literal('existing'),
			publication: recordedPublicationSchema
		}),
		z.strictObject({
			kind: z.literal('staging'),
			operationId: publicationOperationIdSchema,
			expiresAt: isoTimestampSchema
		})
	]
);
export type PublicationCaptureBeginResponse = z.output<
	typeof publicationCaptureBeginResponseSchema
>;

const pageSchema = countSchema.max(publicationManifestMaxMembers - 1);
export const publicationCapturePageRequestSchema = z.strictObject({
	operationId: publicationOperationIdSchema,
	page: pageSchema,
	members: z
		.array(publicationPathVersionSchema)
		.min(1)
		.max(publicationManifestPageMaxMembers)
		.refine(
			(members) =>
				new Set(members.map((member) => member.storePath)).size ===
				members.length,
			'Each store path must appear once in a capture page'
		)
});
export type PublicationCapturePageRequest = z.output<
	typeof publicationCapturePageRequestSchema
>;

export const publicationCapturePageResponseSchema = z.strictObject({
	operationId: publicationOperationIdSchema,
	page: pageSchema,
	// Number of members accepted by this page, not a cumulative count.
	acceptedCount: countSchema.min(1).max(publicationManifestPageMaxMembers)
});
export type PublicationCapturePageResponse = z.output<
	typeof publicationCapturePageResponseSchema
>;

export const publicationCaptureSealRequestSchema = z.strictObject({
	operationId: publicationOperationIdSchema
});
export type PublicationCaptureSealRequest = z.output<
	typeof publicationCaptureSealRequestSchema
>;

export const publicationAssociationSchema = z.enum(['created', 'existing']);
export type PublicationAssociation = z.output<
	typeof publicationAssociationSchema
>;
const publicationCapturedSchema = z.strictObject({
	kind: z.literal('captured'),
	association: publicationAssociationSchema,
	publication: recordedPublicationSchema
});
const publicationPendingSchema = z.strictObject({
	kind: z.literal('pending'),
	operationId: publicationOperationIdSchema
});
// Repeated seal calls advance at most one bounded phase step. Captured
// membership is not a certificate of complete destination materialisation.
export const publicationCaptureSealResponseSchema = z.discriminatedUnion(
	'kind',
	[publicationCapturedSchema, publicationPendingSchema]
);
export type PublicationCaptureSealResponse = z.output<
	typeof publicationCaptureSealResponseSchema
>;

export const publicationEnsureRequestSchema = z.strictObject({
	requestId: publicationRequestIdSchema,
	source: recordedPublicationSchema,
	expectedDestinationGeneration: cacheGenerationSchema,
	sourceSelector: publicationSourceSelectorSchema.optional(),
	// Must already exist. Independently require root:attach for this destination
	// and root; commit authority alone never permits retention attachment.
	runRoot: rootNameSchema.optional()
});
export type PublicationEnsureRequest = z.output<
	typeof publicationEnsureRequestSchema
>;

const publicationCompleteSchema = z.strictObject({
	kind: z.literal('complete'),
	publication: compactPublicationSetSchema,
	association: publicationAssociationSchema
});
export const publicationEnsureResponseSchema = z.discriminatedUnion('kind', [
	publicationCompleteSchema,
	publicationPendingSchema
]);
export type PublicationEnsureResponse = z.output<
	typeof publicationEnsureResponseSchema
>;

export const publicationStatusRequestSchema = z.strictObject({
	operationId: publicationOperationIdSchema
});
export type PublicationStatusRequest = z.output<
	typeof publicationStatusRequestSchema
>;

export const publicationFailureReasonSchema = z.enum([
	'result-changed',
	'source-unavailable',
	'scope-changed',
	'generation-conflict',
	'divergence',
	'expired',
	'temporary-failure'
]);
export type PublicationFailureReason = z.output<
	typeof publicationFailureReasonSchema
>;
// Status only observes durable work; unlike captureSeal it never advances it.
export const publicationStatusResponseSchema = z.discriminatedUnion('kind', [
	publicationPendingSchema,
	publicationCapturedSchema,
	publicationCompleteSchema,
	z.strictObject({
		kind: z.literal('failed'),
		reason: publicationFailureReasonSchema
	})
]);
export type PublicationStatusResponse = z.output<
	typeof publicationStatusResponseSchema
>;

export const publicationManifestLimitErrorCode = 'PUBLICATION_LIMIT_EXCEEDED';
export const publicationManifestLimitErrorDataSchema = z.strictObject({
	limit: z.enum([
		'lookup-results',
		'page-members',
		'total-members',
		'request-bytes'
	]),
	maximum: countSchema
});
export type PublicationManifestLimitErrorData = z.output<
	typeof publicationManifestLimitErrorDataSchema
>;

export const publicationManifestMembersSchema = z
	.array(publicationMemberSchema)
	.min(1)
	.max(publicationManifestMaxMembers)
	.refine((members) => {
		const hashes = new Map<string, string>();
		for (const member of members) {
			const previous = hashes.get(member.storePath);
			if (previous !== undefined && previous !== member.narHash) {
				return false;
			}
			hashes.set(member.storePath, member.narHash);
		}
		return true;
	}, 'One store path cannot have conflicting NAR hashes');

export const publicationManifestLeafDigestSchema = sha256HexDigestSchema.brand(
	'PublicationManifestLeafDigest'
);
export type PublicationManifestLeafDigest = z.output<
	typeof publicationManifestLeafDigestSchema
>;

export const publicationManifestLeafMembersSchema =
	publicationManifestMembersSchema.max(publicationManifestPageMaxMembers);
export const publicationManifestRootSchema = z
	.strictObject({
		memberCount: memberCountSchema,
		pageDigests: z
			.array(publicationManifestLeafDigestSchema)
			.min(1)
			.max(
				Math.ceil(
					publicationManifestMaxMembers / publicationManifestPageMaxMembers
				)
			)
	})
	.refine(
		(root) =>
			root.pageDigests.length ===
			Math.ceil(root.memberCount / publicationManifestPageMaxMembers),
		'A manifest root requires one digest per fixed 64-member leaf'
	);
export type PublicationManifestRoot = z.output<
	typeof publicationManifestRootSchema
>;
export type PublicationManifestRootInput = z.input<
	typeof publicationManifestRootSchema
>;

export interface PublicationManifestRootIdentityInput {
	readonly memberCount: PublicationManifestRootInput['memberCount'];
	readonly pageDigests: Readonly<PublicationManifestRootInput['pageDigests']>;
}

export interface PublicationManifestRootIdentity {
	readonly digest: PublicationDigest;
	readonly canonical: string;
}
export interface PublicationManifestLeafIdentity {
	readonly digest: PublicationManifestLeafDigest;
	readonly canonical: string;
	readonly members: readonly PublicationMember[];
}
export interface PublicationManifestIdentity extends PublicationManifestRootIdentity {
	readonly members: readonly PublicationMember[];
}

function normaliseMembers(
	checked: readonly PublicationMember[]
): PublicationMember[] {
	return new Map(checked.map((member) => [member.storePath, member]))
		.values()
		.toArray()
		.toSorted((left, right) => byCodeUnit(left.storePath, right.storePath));
}

async function manifestDigest(canonical: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonical)
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

/**
Hashes at most 64 members once. Services supply globally sorted leaf boundaries.
*/
export async function publicationManifestLeafIdentity(
	input: readonly PublicationMemberInput[]
): Promise<PublicationManifestLeafIdentity> {
	const members = normaliseMembers(
		publicationManifestLeafMembersSchema.parse(input)
	);
	const canonical = JSON.stringify({ version: 1, members });
	return {
		digest: publicationManifestLeafDigestSchema.parse(
			await manifestDigest(canonical)
		),
		canonical,
		members
	};
}

/**
Hashes the bounded root once; members and pageDigests are distinct encoding domains.
*/
export async function publicationManifestRootIdentity(
	input: PublicationManifestRootIdentityInput
): Promise<PublicationManifestRootIdentity> {
	const { memberCount, pageDigests } =
		publicationManifestRootSchema.parse(input);
	const canonical = JSON.stringify({ version: 1, memberCount, pageDigests });
	return {
		digest: publicationDigestSchema.parse(await manifestDigest(canonical)),
		canonical
	};
}

/**
Convenience identity for portable membership, independent of cache generations.
Services use the bounded leaf/root helpers rather than loading the whole set.
*/
export async function publicationManifestIdentity(
	input: readonly PublicationMemberInput[]
): Promise<PublicationManifestIdentity> {
	const members = normaliseMembers(
		publicationManifestMembersSchema.parse(input)
	);
	const pageDigests: PublicationManifestLeafDigest[] = [];
	for (
		let offset = 0;
		offset < members.length;
		offset += publicationManifestPageMaxMembers
	) {
		const leaf = await publicationManifestLeafIdentity(
			members.slice(offset, offset + publicationManifestPageMaxMembers)
		);
		pageDigests.push(leaf.digest);
	}
	return {
		...(await publicationManifestRootIdentity({
			memberCount: members.length,
			pageDigests
		})),
		members
	};
}

export type PublicationPathVersionInput = z.input<
	typeof publicationPathVersionSchema
>;
export type PublicationResultIdentityInput = z.input<
	typeof publicationResultIdentitySchema
>;
export type PublicationMemberInput = z.input<typeof publicationMemberSchema>;
export type RecordedPublicationInput = z.input<
	typeof recordedPublicationSchema
>;
export type CompactPublicationSetInput = z.input<
	typeof compactPublicationSetSchema
>;
export type PublicationSourceSelectorInput = z.input<
	typeof publicationSourceSelectorSchema
>;
export type PublicationLookupTargetInput = z.input<
	typeof publicationLookupTargetSchema
>;
export type PublicationLookupSourceSelectorInput = z.input<
	typeof publicationLookupSourceSelectorSchema
>;
export type PublicationLookupSourceInput = z.input<
	typeof publicationLookupSourceSchema
>;
export type PublicationLookupRequestInput = z.input<
	typeof publicationLookupRequestSchema
>;
export type PublicationLookupEntryInput = z.input<
	typeof publicationLookupEntrySchema
>;
export type PublicationLookupResponseInput = z.input<
	typeof publicationLookupResponseSchema
>;
export type PublicationCaptureBeginRequestInput = z.input<
	typeof publicationCaptureBeginRequestSchema
>;
export type PublicationCaptureBeginResponseInput = z.input<
	typeof publicationCaptureBeginResponseSchema
>;
export type PublicationCapturePageRequestInput = z.input<
	typeof publicationCapturePageRequestSchema
>;
export type PublicationCapturePageResponseInput = z.input<
	typeof publicationCapturePageResponseSchema
>;
export type PublicationCaptureSealRequestInput = z.input<
	typeof publicationCaptureSealRequestSchema
>;
export type PublicationCaptureSealResponseInput = z.input<
	typeof publicationCaptureSealResponseSchema
>;
export type PublicationEnsureRequestInput = z.input<
	typeof publicationEnsureRequestSchema
>;
export type PublicationEnsureResponseInput = z.input<
	typeof publicationEnsureResponseSchema
>;
export type PublicationStatusRequestInput = z.input<
	typeof publicationStatusRequestSchema
>;
export type PublicationStatusResponseInput = z.input<
	typeof publicationStatusResponseSchema
>;
