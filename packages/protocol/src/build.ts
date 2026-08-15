import {
	positiveIntSchema,
	sha256HexDigestSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';

// Each wire shape here is declared once and exposed two ways. The plain alias
// is what a builder assembles: the hook putting together an event, the build
// command putting together a receipt. The `Parsed…` output is what a
// successful parse yields, and code that consumes a validated value takes that
// branded form.

// A derivation's own store path: the `.drv` file a build event and a receipt
// subject name their derivation by. Its own brand keeps it distinct from the
// output paths the derivation produces.
export const derivationPathSchema = storePathSchema
	.refine((value) => value.endsWith('.drv'))
	.brand('DerivationPath');
export type DerivationPath = z.output<typeof derivationPathSchema>;

// The identity of one supervising invocation. Opaque: beyond being non-empty,
// the brand is its only constraint.
export const invocationIdSchema = z.string().min(1).brand('InvocationId');
export type InvocationId = z.output<typeof invocationIdSchema>;

// The post-build hook's wire message: one per executed build, naming the
// derivation and the completed output paths, delivered to the supervising
// invocation's local endpoint. The format is private to the hook and its
// supervisor and deliberately small; the version field is what lets it evolve,
// so a reader can refuse a message from a hook it does not understand.
export const buildEventSchema = z.strictObject({
	version: z.literal(1),
	invocationId: invocationIdSchema,
	derivation: derivationPathSchema,
	outputPaths: z.array(storePathSchema).min(1)
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

// What a `built` subject rests on: which producer built the path, and how the
// run knows.
//
// `local` means a supervised attempt built it on the coordinating machine
// and the activity log recorded that build. `build-store` means the selected
// store holds the path as its own work; the run did not watch that build, so
// the store's report is the only evidence. When the activity log recorded a
// builder for the deriver, the subject also records that builder in
// `machine`. A subject records which producer the path came from and nothing
// more. Deciding whether to trust that producer is left to whoever reads the
// receipt.
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

// A path's content address as the store recorded it, in Nix's own form:
// `fixed:r:sha256:…` for a fixed-output path, `text:sha256:…` for a file added
// to the store. A reader can recompute the address from the NAR the
// destination serves, which gives it something to check for a copied path that
// carries no signature.
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

// A subject's `origin` records where a published path came from, as far as the
// run can establish.
//
// `built` means the run realised the path itself. `store-held` means the store
// registered the path as its own work, but nothing the run saw shows that this
// invocation is what realised it; a store kept between runs may have built the
// path earlier. `copied` means the store did not build the path at all, so it
// entered the store from somewhere else. `republished` means no store the push
// could query held the path: the run read the path's metadata from another
// cache, and the destination serves the copy it already had.

// Every subject records the path and the NAR hash the destination serves it
// under, whatever its origin. The attestation step checks both against the
// destination's committed narinfo before signing.
const subjectIdentityFields = {
	storePath: storePathSchema,
	narHash: sha256HexDigestSchema
};

// A path the run realised: the derivation that produced it, the store it was
// realised in, the evidence behind the claim, and the builder from the activity
// log when the log recorded one.
export const builtOriginFields = {
	...subjectIdentityFields,
	derivation: derivationPathSchema,
	buildStore: buildStoreSchema,
	machine: z.string().min(1).optional(),
	verification: subjectVerificationSchema
};

// A path the store registered as its own work, without the run watching the
// build. That registration is all the evidence there is: the subject records
// the store, and no field says when the build ran.
export const storeHeldOriginFields = {
	...subjectIdentityFields,
	derivation: derivationPathSchema.optional(),
	buildStore: buildStoreSchema
};

// A path that entered the store from elsewhere. The subject carries the
// signatures the store holds over the path, and the content address when the
// path has one. A reader can check both for itself.
//
// `copiedFrom` names the stores the run watched the path being copied from, in
// the order the activity log recorded them. It is an observation of this run
// and not a property of the path: the store keeps no record of which
// substituter served a path, so a path that was already valid before the run
// started, or that some other store fetched where the run could not see it, has
// no entry. A path has more than one entry when the run copied it more than
// once, which happens when Nix moves on to the next substituter after a fetch
// fails.
export const copiedOriginFields = {
	...subjectIdentityFields,
	derivation: derivationPathSchema.optional(),
	signatures: z.array(subjectSignatureSchema),
	ca: subjectContentAddressSchema.optional(),
	copiedFrom: z.array(nixStoreUriSchema).min(1).optional()
};

// A path published by reference. No store the push can query holds it, so the
// run read the path's metadata from another cache instead. `metadataSource` is
// that cache, and the signatures are the ones it published over the path. The
// run transferred no bytes: the destination already held the path, and no field
// here describes where the destination's copy came from.
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

// One receipt subject: one published path and the origin the run established
// for it. A supervised build records the attempt that produced the path; a
// reconciled build leaves the attempt fields out, because it inspects the store
// after the build and never watches the build itself.
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

// The planner's partition of the requested targets. `willBuild`,
// `willSubstitute` and `unknown` are the realisation split Nix reports; a
// raised `unknown` count records that a substituter did not answer, so the run
// treated those targets as ones to build. `attached`, `adopted` and
// `leftUpstream` are the publication split the availability questions produce.
export const plannerPartitionSchema = z.strictObject({
	willBuild: countSchema,
	willSubstitute: countSchema,
	unknown: countSchema,
	attached: countSchema,
	adopted: countSchema,
	leftUpstream: countSchema
});
export type ParsedPlannerPartition = z.output<typeof plannerPartitionSchema>;

// The byte totals Nix reports for the paths the planner will substitute: the
// compressed transfer and the unpacked NAR bytes.
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
