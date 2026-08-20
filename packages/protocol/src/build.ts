import {
	positiveIntSchema,
	sha256HexDigestSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';

// Each wire format has one schema. Builders use the input type to create events
// and receipts. Consumers use the branded output type after successful
// validation.

// The store path of the derivation itself. A separate brand distinguishes the
// `.drv` path from its output paths.
export const derivationPathSchema = storePathSchema
	.refine((value) => value.endsWith('.drv'))
	.brand('DerivationPath');
export type DerivationPath = z.output<typeof derivationPathSchema>;

// The identity of one supervising invocation. Opaque: beyond being non-empty,
// the brand is its only constraint.
export const invocationIdSchema = z.string().min(1).brand('InvocationId');
export type InvocationId = z.output<typeof invocationIdSchema>;

// The post-build hook sends one message for each executed build. The message
// contains the derivation and completed output paths and goes to the
// supervisor's local endpoint. The hook and supervisor own this private format.
// A version field lets the receiver reject formats it does not understand.
export const buildEventSchema = z.strictObject({
	version: z.literal(1),
	invocationId: invocationIdSchema,
	derivation: derivationPathSchema,
	outputPaths: z.array(storePathSchema).min(1),
	/**
	The hook could not protect these outputs from garbage collection. The
	supervisor records them for publication after the build but does not stream
	them.
	*/
	outputProtection: z.literal('failed').optional()
});
export type ParsedBuildEvent = z.output<typeof buildEventSchema>;

// One path this run built, attributed to the attempt whose activity produced
// it. The attestation step verifies a subject's NAR hash and deriver against
// the live store before it emits a checksum for it.
export const buildSubjectV2Schema = z.strictObject({
	storePath: storePathSchema,
	narHash: sha256HexDigestSchema,
	derivation: derivationPathSchema,
	attempt: positiveIntSchema,
	attemptId: z.string().min(1)
});
export type ParsedBuildSubjectV2 = z.output<typeof buildSubjectV2Schema>;

// The store containing the realised paths: the selected `--store` value, or
// `auto` when Nix selects the store. Store values are opaque here; the schema
// requires only that they are non-empty.
export const buildStoreSchema = z.string().min(1).brand('BuildStore');
export type BuildStore = z.output<typeof buildStoreSchema>;

/**
The value recorded when Nix selects the store.
*/
export const autoBuildStore = 'auto';

// How the run established that a producer built this subject.
//
// `local` means the activity log recorded a supervised attempt on the
// coordinating machine. `build-store` means the selected store reported the
// path as one of its builds, but the run did not observe that build. When
// available, `machine` identifies the builder from the activity log. The receipt
// records the producer but does not determine whether that producer is trusted.
export const subjectVerificationSchema = z.enum(['local', 'build-store']);
export type SubjectVerification = z.output<typeof subjectVerificationSchema>;

// One narinfo `Sig` entry as the store recorded it: a key name, a colon and
// base64 signature material. The receipt copies the entry without interpreting
// it, so a reader parses and checks it exactly as Nix does.
export const subjectSignatureSchema = z
	.string()
	.min(1)
	.brand('SubjectSignature');
export type SubjectSignature = z.output<typeof subjectSignatureSchema>;

// The content address recorded by Nix, in its own form:
// `fixed:r:sha256:…` for a fixed-output path, `text:sha256:…` for a file added
// to the store. A reader can recompute this value from the served NAR and use it
// to verify a copied path that has no signature.
export const subjectContentAddressSchema = z
	.string()
	.min(1)
	.brand('SubjectContentAddress');
export type SubjectContentAddress = z.output<
	typeof subjectContentAddressSchema
>;

// The identifier Nix prints for a store in its log output: a URI such as
// `https://cache.nixos.org` or `ssh://builder`, or a bare word such as
// `local`. The value is opaque here; the schema requires only that it is not
// empty.
export const nixStoreUriSchema = z.string().min(1).brand('NixStoreUri');
export type NixStoreUri = z.output<typeof nixStoreUriSchema>;

// A subject's `origin` records the source of a published path as far as the run
// can determine it.
//
// `built` means the run realised the path itself. `store-held` means the store
// registered the path as one of its builds, but the run did not observe when it
// was built. `copied` means the path entered the store from another source.
// `republished` means the run found the path's metadata in another cache because
// no queried store contained it. The destination already contained the bytes.

// Every subject records its store path and NAR hash. Before signing, the
// attestation step compares both values with the destination's committed
// narinfo.
const subjectIdentityFields = {
	storePath: storePathSchema,
	narHash: sha256HexDigestSchema
};

// A path realised by the run, including its derivation, build store, verification
// method, and the builder recorded by the activity log when available.
export const builtOriginFields = {
	...subjectIdentityFields,
	derivation: derivationPathSchema,
	buildStore: buildStoreSchema,
	machine: z.string().min(1).optional(),
	verification: subjectVerificationSchema
};

// A path the store registered as one of its builds without the run observing the
// build. The subject records the store but contains no build time.
export const storeHeldOriginFields = {
	...subjectIdentityFields,
	derivation: derivationPathSchema.optional(),
	buildStore: buildStoreSchema
};

// A path copied into the store. `signatures` contains the signatures recorded by
// the store, and `ca` contains its content address when available. A reader can
// verify both values.
//
// `copiedFrom` lists the source stores observed by this run in activity-log
// order. Nix does not persist the source substituter, so the field is absent when
// the run did not observe the copy. The list contains several entries when Nix
// tried another substituter after a fetch failed.
export const copiedOriginFields = {
	...subjectIdentityFields,
	derivation: derivationPathSchema.optional(),
	signatures: z.array(subjectSignatureSchema),
	ca: subjectContentAddressSchema.optional(),
	copiedFrom: z.array(nixStoreUriSchema).min(1).optional()
};

// A path published by reference. No store queried by the push contains the path,
// so the run reads its metadata from `metadataSource`. The signatures are those
// published by that cache. The destination already contains the bytes, and this
// record does not identify their source.
export const republishedOriginFields = {
	...subjectIdentityFields,
	derivation: derivationPathSchema.optional(),
	signatures: z.array(subjectSignatureSchema),
	ca: subjectContentAddressSchema.optional(),
	metadataSource: z.url()
};

// The copies a run watched while it built: one entry per path, listing the
// stores the path was read from in the order the run observed them. A build and
// the push that publishes its results run as separate processes, so the
// supervising process writes this document and the push reads it.
export const observedCopiesSchema = z.record(
	storePathSchema,
	z.array(nixStoreUriSchema).min(1)
);
export type ParsedObservedCopies = z.output<typeof observedCopiesSchema>;
export type ObservedCopies = z.input<typeof observedCopiesSchema>;

// One published path and its observed origin. A supervised build includes the
// attempt that produced the path. A reconciled build inspects the store after
// completion and therefore omits the attempt fields.
export const buildSubjectV3Schema = z.discriminatedUnion('origin', [
	z.strictObject({
		origin: z.literal('built'),
		...builtOriginFields,
		attempt: positiveIntSchema.optional(),
		attemptId: z.string().min(1).optional()
	}),
	z.strictObject({ origin: z.literal('store-held'), ...storeHeldOriginFields }),
	z.strictObject({ origin: z.literal('copied'), ...copiedOriginFields }),
	z.strictObject({
		origin: z.literal('republished'),
		...republishedOriginFields
	})
]);
export type ParsedBuildSubjectV3 = z.output<typeof buildSubjectV3Schema>;
export type SubjectOrigin = ParsedBuildSubjectV3['origin'];

// Why a failed target failed: the build itself, the upload of its NAR, the
// destination's verification of the upload, the retention root that should
// have covered it, or local collection removing the path before its NAR could
// be read. A build failure must never present as a cache failure or vice
// versa, so the receipt records the cause as a kind, not prose.
export const targetFailureReasonSchema = z.enum([
	'build',
	'upload',
	'verification',
	'retention',
	'collected'
]);
export type TargetFailureReason = z.output<typeof targetFailureReasonSchema>;

// One target path's terminal state in a run: built and published, already
// served by the destination, published by reference from a durable upstream,
// deliberately left upstream, failed for a recorded reason, or collected
// locally before publication (terminal for an intermediate; a collected
// target is a failure and carries that reason instead).
export const targetOutcomeSchema = z.discriminatedUnion('outcome', [
	z.strictObject({
		outcome: z.literal('built'),
		storePath: storePathSchema
	}),
	z.strictObject({
		outcome: z.literal('destination-served'),
		storePath: storePathSchema
	}),
	z.strictObject({
		outcome: z.literal('published-by-reference'),
		storePath: storePathSchema
	}),
	z.strictObject({
		outcome: z.literal('left-upstream'),
		storePath: storePathSchema
	}),
	z.strictObject({
		outcome: z.literal('failed'),
		storePath: storePathSchema,
		reason: targetFailureReasonSchema
	}),
	z.strictObject({
		outcome: z.literal('collected'),
		storePath: storePathSchema
	})
]);
export type ParsedTargetOutcome = z.output<typeof targetOutcomeSchema>;

// The planner's estimate after the action copies the selected local paths.
// `unknown` counts store paths that neither the store nor its substituters can
// currently provide; planning refuses when this exceeds the configured ceiling.
// When a remote daemon keeps its own substitution policy, `willBuild` and
// `willSubstitute` are conservative upper bounds for either possible policy.
// `attached`, `adopted` and `leftUpstream` describe publication of the targets.
export const plannerPartitionSchema = z.strictObject({
	willBuild: countSchema,
	willSubstitute: countSchema,
	unknown: countSchema,
	attached: countSchema,
	adopted: countSchema,
	leftUpstream: countSchema
});
export type ParsedPlannerPartition = z.output<typeof plannerPartitionSchema>;

// The estimated substitution capacity after planned local paths are copied:
// the compressed transfer and unpacked NAR bytes. These values include the
// conservative substitution branch when the remote daemon's policy is unknown.
export const substitutableSizesSchema = z.strictObject({
	downloadSize: countSchema,
	narSize: countSchema
});
export type ParsedSubstitutableSizes = z.output<
	typeof substitutableSizesSchema
>;

// Why the supervised child failed. A target-build failure identifies the
// failed installables. A command failure does not, because Nix may have exited
// before reporting a final result for every requested target.
const failedBuildTargetsSchema = z.array(z.string().min(1)).min(1);

export const terminalBuildFailureSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('target-build'),
		failedTargets: failedBuildTargetsSchema
	}),
	z.strictObject({ kind: z.literal('command') })
]);
export type ParsedTerminalBuildFailure = z.output<
	typeof terminalBuildFailureSchema
>;

// What every receipt version records besides its subjects: the realised paths
// and, when the run planned and published, the per-target outcomes, the
// planner's counts and sizes, the timings and child exit status, and the
// publication path lists. A run that only builds writes the required fields and
// omits the rest.
const buildReceiptFields = {
	paths: z.array(storePathSchema),
	outcomes: z.array(targetOutcomeSchema).optional(),
	planner: plannerPartitionSchema.optional(),
	substitutable: substitutableSizesSchema.optional(),
	evaluationTimeMs: countSchema.optional(),
	childExitStatus: z.number().int().optional(),
	terminalFailure: terminalBuildFailureSchema.optional(),
	uploaded: z.array(storePathSchema).optional(),
	failed: z.array(storePathSchema).optional(),
	collected: z.array(storePathSchema).optional()
};

// Version 2 records subjects attributed to supervised build attempts.
export const buildReceiptV2Schema = z.strictObject({
	version: z.literal(2),
	subjects: z.array(buildSubjectV2Schema),
	...buildReceiptFields
});
export type ParsedBuildReceiptV2 = z.output<typeof buildReceiptV2Schema>;

// Version 3 records one subject per path the run published: each path it read
// from the build store, whether the run built the path or found it already
// there, and each path it republished from another cache's served metadata.
export const buildReceiptV3Schema = z.strictObject({
	version: z.literal(3),
	subjects: z.array(buildSubjectV3Schema),
	...buildReceiptFields
});
export type ParsedBuildReceiptV3 = z.output<typeof buildReceiptV3Schema>;

// All supported receipt versions, discriminated by `version`.
export const buildReceiptSchema = z.discriminatedUnion('version', [
	buildReceiptV2Schema,
	buildReceiptV3Schema
]);
export type ParsedBuildReceipt = z.output<typeof buildReceiptSchema>;

// The shapes a builder assembles: a schema's input is unbranded, so the hook
// constructs an event and the build command a receipt from these forms
// directly.
export type BuildEvent = z.input<typeof buildEventSchema>;
export type BuildSubjectV2 = z.input<typeof buildSubjectV2Schema>;
export type BuildSubjectV3 = z.input<typeof buildSubjectV3Schema>;
export type TargetOutcome = z.input<typeof targetOutcomeSchema>;
export type PlannerPartition = z.input<typeof plannerPartitionSchema>;
export type SubstitutableSizes = z.input<typeof substitutableSizesSchema>;
export type TerminalBuildFailure = z.input<typeof terminalBuildFailureSchema>;
export type BuildReceiptV2 = z.input<typeof buildReceiptV2Schema>;
export type BuildReceiptV3 = z.input<typeof buildReceiptV3Schema>;
export type BuildReceipt = z.input<typeof buildReceiptSchema>;
