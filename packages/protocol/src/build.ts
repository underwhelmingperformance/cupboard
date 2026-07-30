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
export const buildSubjectSchema = z.strictObject({
	storePath: storePathSchema,
	narHash: sha256HexDigestSchema,
	derivation: derivationPathSchema,
	attempt: positiveIntSchema,
	attemptId: z.string().min(1)
});
export type ParsedBuildSubject = z.output<typeof buildSubjectSchema>;

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

// The authoritative record one run writes: the realised paths, the subjects
// this machine built, and, when the run planned and published, the per-target
// outcomes, the planner's counts and sizes, the timings and child exit status,
// and the publication path lists. A run that only builds writes the required
// fields and omits the rest.
export const buildReceiptSchema = z.strictObject({
	version: z.literal(2),
	paths: z.array(storePathSchema),
	subjects: z.array(buildSubjectSchema),
	outcomes: z.array(targetOutcomeSchema).optional(),
	planner: plannerPartitionSchema.optional(),
	substitutable: substitutableSizesSchema.optional(),
	evaluationTimeMs: countSchema.optional(),
	childExitStatus: z.number().int().optional(),
	uploaded: z.array(storePathSchema).optional(),
	failed: z.array(storePathSchema).optional(),
	collected: z.array(storePathSchema).optional()
});
export type ParsedBuildReceipt = z.output<typeof buildReceiptSchema>;

// The shapes a builder assembles: a schema's input is unbranded, so the hook
// constructs an event and the build command a receipt from these forms
// directly.
export type BuildEvent = z.input<typeof buildEventSchema>;
export type BuildSubject = z.input<typeof buildSubjectSchema>;
export type TargetOutcome = z.input<typeof targetOutcomeSchema>;
export type PlannerPartition = z.input<typeof plannerPartitionSchema>;
export type SubstitutableSizes = z.input<typeof substitutableSizesSchema>;
export type BuildReceipt = z.input<typeof buildReceiptSchema>;
