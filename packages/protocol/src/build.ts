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
// subject name their derivation by. Its own brand keeps it from crossing with
// the output paths the derivation produces.
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

// The store a run realised its paths in: the `--store` URI the run selected,
// or `auto` for the store Nix itself would use. Opaque beyond being non-empty,
// so the brand is its only constraint.
export const buildStoreSchema = z.string().min(1).brand('BuildStore');
export type BuildStore = z.output<typeof buildStoreSchema>;

/** The store Nix itself would use, which a run selecting none builds in. */
export const autoBuildStore = 'auto';

// How far the machine running the push established that a subject is what this
// run produced.
//
// `local` is a build that machine ran itself. `verified-rebuild` is a build
// some other machine ran whose outputs a local rebuild then reproduced.
// `build-store` is a path the selected build store realised: its metadata was
// read back over the store connection and the build itself was not watched, so
// the claim rests on the store the operator configured. That store marks such a
// path ultimately trusted, which it also does for a path added to it directly,
// so the claim covers every path the store holds as its own. `unverified` is a
// build some other machine ran that nothing since has checked, which is not a
// subject anything may attest.
export const subjectVerificationSchema = z.enum([
	'local',
	'verified-rebuild',
	'build-store',
	'unverified'
]);
export type SubjectVerification = z.output<typeof subjectVerificationSchema>;

// One path this run built, with where it was built recorded alongside how it
// was attributed. The attempt fields are present when a supervised attempt loop
// produced the path; a run that reconciles its subjects from the store after
// the build has no attempt loop to name. `machine` names the builder the
// activity log recorded, absent when the run only knows the path was not built
// on the machine that ran the push.
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

// The planner's partition of the requested targets: the realisation split Nix
// reports (a raised `unknown` count is the record that a substituter did not
// answer and the run degraded toward building) plus the publication split the
// availability questions produce.
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

// Why the supervised child ended unsuccessfully. A target-build failure is
// safe for a best-effort caller to tolerate because the receipt also names the
// exact requested installables that failed. A command failure carries no such
// claim: the process may have failed before Nix settled any requested target.
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

// The authoritative record one run writes, in the form whose subjects carry the
// attempt attribution alone.
export const buildReceiptV2Schema = z.strictObject({
	version: z.literal(2),
	subjects: z.array(buildSubjectV2Schema),
	...buildReceiptFields
});
export type ParsedBuildReceiptV2 = z.output<typeof buildReceiptV2Schema>;

// The same record with each subject carrying where it was built and how far
// that was established, so a reader can tell a path this machine built from one
// a selected store realised, and refuse a path nothing verified.
export const buildReceiptV3Schema = z.strictObject({
	version: z.literal(3),
	subjects: z.array(buildSubjectV3Schema),
	...buildReceiptFields
});
export type ParsedBuildReceiptV3 = z.output<typeof buildReceiptV3Schema>;

// Every receipt a reader accepts, discriminated by version, so a consumer
// written against either form keeps reading the fields both carry.
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
