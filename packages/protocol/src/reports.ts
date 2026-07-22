import {
	nixSha256HashSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';
import { uploadGraceFactSchema } from './upload.ts';

// A storage check reconciles committed metadata against R2: a NAR blob is
// missing, a narinfo R2 object is missing, or a deep file-hash recompute does
// not match the recorded hash.
export const checkDiscrepancyKindSchema = z.enum([
	'missing-nar',
	'missing-narinfo-object',
	'file-hash-mismatch',
	'nar-hash-mismatch',
	'nar-size-mismatch',
	'undecodable'
]);
export type CheckDiscrepancyKind = z.infer<typeof checkDiscrepancyKindSchema>;

export const checkDiscrepancySchema = z.strictObject({
	kind: checkDiscrepancyKindSchema,
	cache: z.string(),
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema
});
export type ParsedCheckDiscrepancy = z.output<typeof checkDiscrepancySchema>;

export const checkReportSchema = z.strictObject({
	narInfosChecked: countSchema,
	narBlobsChecked: countSchema,
	complete: z.boolean(),
	discrepancies: z.array(checkDiscrepancySchema)
});
export type ParsedCheckReport = z.output<typeof checkReportSchema>;

// One bounded pass of background verification: how many narinfo rows it scanned,
// how many missing narinfo objects it re-materialised, how many dangling
// narinfos (their NAR gone) it removed, and the resume position as a composite
// (cursorCache, cursor), both empty once the scan has wrapped, so the next pass
// starts at the first cache's lowest store path hash.
export const verifyReportSchema = z.strictObject({
	scanned: countSchema,
	narInfoObjectsRestored: countSchema,
	danglingNarInfosRemoved: countSchema,
	cursor: z.string(),
	cursorCache: z.string(),
	wrapped: z.boolean()
});
export type ParsedVerifyReport = z.output<typeof verifyReportSchema>;

// Whether the R2 credentials bound to the tenant script sign requests R2
// accepts: the values cannot be read back, so the deployment proves them by
// performing a signed probe itself. The probe runs inside a tenant's Durable
// Object (the script that holds the credentials), so a deployment with no
// tenants yet has nowhere to run it.
export const r2CredentialCheckSchema = z.discriminatedUnion('result', [
	z.strictObject({ result: z.literal('ok') }),
	z.strictObject({ result: z.literal('rejected'), status: z.number().int() }),
	z.strictObject({ result: z.literal('unconfigured') }),
	z.strictObject({ result: z.literal('no-tenant') })
]);
export type ParsedR2CredentialCheck = z.output<typeof r2CredentialCheckSchema>;

// Whether the control database answers a trivial read. The bare-host control
// surface can serve `/_version` from a previous Worker version before the new
// version's D1 binding is live, so a deploy proves readiness through this rather
// than the version probe alone.
export const controlDatabaseCheckSchema = z.discriminatedUnion('result', [
	z.strictObject({ result: z.literal('ok') }),
	z.strictObject({ result: z.literal('error') })
]);
export type ParsedControlDatabaseCheck = z.output<
	typeof controlDatabaseCheckSchema
>;

// The admin-gated deployment check served by the control plane. Future
// deployment diagnostics join the report as further fields.
export const controlCheckReportSchema = z.strictObject({
	db: controlDatabaseCheckSchema,
	r2: r2CredentialCheckSchema
});
export type ParsedControlCheckReport = z.output<
	typeof controlCheckReportSchema
>;

// The `kind` under which `cupboard push` emits its final summary result. A
// consumer that reads the reporter's result file addresses the summary by this
// name.
export const pushSummaryResultKind = 'push-summary';

// A path that failed to upload, commit or verify. The push presses on with the
// rest, so a failure is reported alongside whatever succeeded, not in place of
// it.
export const pushFailureSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	storePath: storePathSchema,
	stage: z.enum(['upload', 'commit', 'verify']),
	reason: z.string()
});
export type ParsedPushFailure = z.output<typeof pushFailureSchema>;

// One path's outcome and retention fact, mirroring `commitResponseSchema`'s
// status values: `already-present` is a negotiate skip (already committed
// before this push touched it); `committed` is a fresh upload or a reused blob
// that settled; `pending` is a deferred upload the push did not wait for
// (`--no-wait`). `grace` carries a materialised `retainUntil` for
// `already-present` and `committed` outcomes, or the captured `graceSeconds`
// for a `pending` one whose deadline is not yet known; absent when no policy
// matched, or when the push carried no retention plan at all (an older
// server's legacy response).
export const pushSummaryPathSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	storePath: storePathSchema.optional(),
	outcome: z.enum(['committed', 'already-present', 'pending']),
	grace: uploadGraceFactSchema.optional()
});
export type ParsedPushSummaryPath = z.output<typeof pushSummaryPathSchema>;

// The push-summary result data a `cupboard push` emits, parsed back by the
// actions so they can read uploaded/reused/skipped counts, failures, and each
// path's retention fact without casting the reporter's untyped JSON.
export const pushSummarySchema = z.strictObject({
	uploadedPaths: countSchema,
	reusedBlobs: countSchema,
	skipped: countSchema,
	uploadedBytes: countSchema,
	failures: z.array(pushFailureSchema),
	paths: z.array(pushSummaryPathSchema)
});
export type ParsedPushSummary = z.output<typeof pushSummarySchema>;

export type CheckDiscrepancy = z.input<typeof checkDiscrepancySchema>;
export type CheckReport = z.input<typeof checkReportSchema>;
export type ControlCheckReport = z.input<typeof controlCheckReportSchema>;
export type VerifyReport = z.input<typeof verifyReportSchema>;
export type PushFailure = z.input<typeof pushFailureSchema>;
export type PushSummaryPath = z.input<typeof pushSummaryPathSchema>;
export type PushSummary = z.input<typeof pushSummarySchema>;
