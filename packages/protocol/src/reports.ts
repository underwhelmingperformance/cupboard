import { z } from 'zod';

import { countSchema } from './internal/counts.ts';

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
	storePathHash: z.string(),
	narHash: z.string()
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

// The `kind` under which `cupboard push` emits its final summary result. A
// consumer that reads the reporter's result file addresses the summary by this
// name.
export const pushSummaryResultKind = 'push-summary';

// A path the push could not upload or commit, and the stage it failed at,
// carried in the push summary so a consumer can report each failure.
export const pushFailureSchema = z.strictObject({
	storePathHash: z.string(),
	storePath: z.string(),
	stage: z.enum(['upload', 'commit', 'verify']),
	reason: z.string()
});
export type ParsedPushFailure = z.output<typeof pushFailureSchema>;

// The `data` behind a `push-summary` result: how many paths `cupboard push`
// uploaded, reused from the cache or skipped, how many bytes it transferred, and
// the paths that failed. The GitHub Action reads it back from the result file to
// set its step outputs.
export const pushSummarySchema = z.strictObject({
	uploadedPaths: countSchema,
	reusedBlobs: countSchema,
	skipped: countSchema,
	uploadedBytes: countSchema,
	failures: z.array(pushFailureSchema)
});
export type ParsedPushSummary = z.output<typeof pushSummarySchema>;

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

export type CheckDiscrepancy = z.input<typeof checkDiscrepancySchema>;
export type CheckReport = z.input<typeof checkReportSchema>;
export type ControlCheckReport = z.input<typeof controlCheckReportSchema>;
export type VerifyReport = z.input<typeof verifyReportSchema>;
export type PushFailure = z.input<typeof pushFailureSchema>;
export type PushSummary = z.input<typeof pushSummarySchema>;
