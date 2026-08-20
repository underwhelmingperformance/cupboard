import {
	nixSha256HashSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';
import { uploadGraceFactSchema } from './upload.ts';

// A storage check reconciles committed metadata against R2. Every check
// reports a missing NAR blob or a missing narinfo object. A deep check reads
// the blob as well, so it also reports a stored object whose checksum or size
// does not match `blob_state` (`file-hash-mismatch`), an uncompressed NAR whose
// hash or size does not match the narinfo row (`nar-hash-mismatch`,
// `nar-size-mismatch`), and a blob that could not be decoded (`undecodable`).
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

// One bounded background-verification pass. The report counts scanned narinfo
// rows, reconstructed narinfo objects, and removed narinfos whose NAR is
// missing. `cursorCache` and `cursor` identify the next row. Both are empty after
// the scan wraps.
export const verifyReportSchema = z.strictObject({
	scanned: countSchema,
	narInfoObjectsRestored: countSchema,
	danglingNarInfosRemoved: countSchema,
	cursor: z.string(),
	cursorCache: z.string(),
	wrapped: z.boolean()
});
export type ParsedVerifyReport = z.output<typeof verifyReportSchema>;

// Checks whether R2 accepts requests signed with the tenant Worker's
// credentials. Bindings do not expose the credential values, so the Worker
// sends a signed probe request. The probe requires a tenant Durable Object; a
// deployment with no tenants reports `no-tenant`.
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

// A path that failed to resolve, upload, commit or verify. The push presses on
// with the rest, so a failure is reported alongside whatever succeeded, not in
// place of it. The `resolve` stage names a declared target the store no longer
// held when its metadata was read.
export const pushFailureSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	storePath: storePathSchema,
	stage: z.enum(['resolve', 'upload', 'commit', 'verify']),
	reason: z.string()
});
export type ParsedPushFailure = z.output<typeof pushFailureSchema>;

// One path's publication outcome and retention result. `already-present` means
// the path was committed before this push. `committed` means a fresh upload or a
// reused blob completed. `pending` means `--no-wait` returned before background
// verification completed. `collected` means the store removed an intermediate
// before its metadata or NAR could be read. `grace` contains `retainUntil` for a
// committed path or `graceSeconds` while a pending path has no deadline. It is
// absent for collected paths, unmatched policies, and legacy responses without
// a retention plan.
export const pushSummaryPathSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	storePath: storePathSchema.optional(),
	outcome: z.enum(['committed', 'already-present', 'pending', 'collected']),
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

// The `kind` under which `cupboard attest attach` emits its final summary
// result. A consumer that reads the reporter's result file addresses the
// summary by this name.
export const attestationAttachSummaryResultKind = 'attestation-attach-summary';

// One named path's attachment outcome. `attached` means at least one bundle was
// newly attached to the path. `reused` means every requested bundle was already
// attached. `unservable` means the cache has no committed copy of the path, so
// no bundle was attached. The response includes only paths referenced by a
// bundle subject.
export const attestationAttachPathSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	storePath: storePathSchema.optional(),
	outcome: z.enum(['attached', 'reused', 'unservable'])
});
export type ParsedAttestationAttachPath = z.output<
	typeof attestationAttachPathSchema
>;

// The attach summary result data: bundle-level attached and reused counts,
// the number of unservable paths, the staged bundle bytes, and each covered
// path's outcome.
export const attestationAttachSummarySchema = z.strictObject({
	attached: countSchema,
	reused: countSchema,
	unservable: countSchema,
	uploadedBytes: countSchema,
	paths: z.array(attestationAttachPathSchema)
});
export type ParsedAttestationAttachSummary = z.output<
	typeof attestationAttachSummarySchema
>;

// The `kind` under which `cupboard build-push` emits its final summary result.
// A consumer that reads the reporter's result file addresses the summary by
// this name.
export const buildSummaryResultKind = 'build-summary';

// The build-push summary records the publication mode and store, path and queue
// counts, child exit status, and paths whose publication did not complete.
// It never includes secrets, presigned URLs, or raw credentials.
//
// `streamed` published each completed output through the daemon's post-build
// hook while the build ran; `reconciled-local` built without the hook and
// published after reading the build's store.
export const buildSummarySchema = z.strictObject({
	mode: z.enum(['streamed', 'reconciled-local']),
	store: z.string().min(1),
	targetPaths: countSchema,
	intermediatePaths: countSchema,
	queueDepth: countSchema,
	uploadedPaths: countSchema,
	skipped: countSchema,
	childExitStatus: z.number().int().nonnegative(),
	unconfirmedPaths: z.array(storePathSchema)
});
export type ParsedBuildSummary = z.output<typeof buildSummarySchema>;

export type CheckDiscrepancy = z.input<typeof checkDiscrepancySchema>;
export type CheckReport = z.input<typeof checkReportSchema>;
export type ControlCheckReport = z.input<typeof controlCheckReportSchema>;
export type VerifyReport = z.input<typeof verifyReportSchema>;
export type PushFailure = z.input<typeof pushFailureSchema>;
export type PushSummaryPath = z.input<typeof pushSummaryPathSchema>;
export type PushSummary = z.input<typeof pushSummarySchema>;
export type AttestationAttachPath = z.input<typeof attestationAttachPathSchema>;
export type AttestationAttachSummary = z.input<
	typeof attestationAttachSummarySchema
>;
export type BuildSummary = z.input<typeof buildSummarySchema>;
