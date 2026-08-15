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

/** The value recorded when Nix selects the store. */
export const autoBuildStore = 'auto';

// Who produced the path a receipt subject records.
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

// One receipt subject and its verification details. Supervised attempts include
// attempt fields. Reconciled builds omit them because they inspect the store
// after the build. `machine` identifies the builder from the activity log and
// is absent when only the remote build location is known.
export const buildSubjectV3Schema = z.strictObject({
	storePath: storePathSchema,
	narHash: sha256HexDigestSchema,
	derivation: derivationPathSchema,
	attempt: positiveIntSchema.optional(),
	attemptId: z.string().min(1).optional(),
	buildStore: buildStoreSchema,
	machine: z.string().min(1).optional(),
	verification: subjectVerificationSchema
});
export type ParsedBuildSubjectV3 = z.output<typeof buildSubjectV3Schema>;

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

// Version 3 also records each subject's build store and verification method.
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
