import {
	cacheScopeSchema,
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
	cache: cacheScopeSchema,
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema
});
export type CheckDiscrepancy = z.output<typeof checkDiscrepancySchema>;

export const checkReportSchema = z.strictObject({
	narInfosChecked: countSchema,
	narBlobsChecked: countSchema,
	complete: z.boolean(),
	discrepancies: z.array(checkDiscrepancySchema)
});
export type CheckReport = z.output<typeof checkReportSchema>;

// One bounded background-verification pass. The report counts scanned narinfo
// rows, reconstructed narinfo objects, and removed narinfos whose NAR is
// missing. `cursorCache` and `cursor` identify the next row when another pass
// must resume the scan.
export const verifyReportSchema = z
	.strictObject({
		scanned: countSchema,
		narInfoObjectsRestored: countSchema,
		danglingNarInfosRemoved: countSchema,
		cursor: storePathHashSchema.optional(),
		cursorCache: cacheScopeSchema.optional(),
		wrapped: z.boolean()
	})
	.refine(
		(report) =>
			(report.cursor === undefined) === (report.cursorCache === undefined),
		{ message: 'Set cursor and cursorCache together' }
	);
export type VerifyReport = z.output<typeof verifyReportSchema>;

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
export type R2CredentialCheck = z.output<typeof r2CredentialCheckSchema>;

// Whether the control database answers a trivial read. The bare-host control
// surface can serve `/_version` from a previous Worker version before the new
// version's D1 binding is live, so a deploy proves readiness through this rather
// than the version probe alone.
export const controlDatabaseCheckSchema = z.discriminatedUnion('result', [
	z.strictObject({ result: z.literal('ok') }),
	z.strictObject({ result: z.literal('error') })
]);
export type ControlDatabaseCheck = z.output<typeof controlDatabaseCheckSchema>;

// The admin-gated deployment check served by the control plane. Future
// deployment diagnostics join the report as further fields.
export const controlCheckReportSchema = z.strictObject({
	db: controlDatabaseCheckSchema,
	r2: r2CredentialCheckSchema
});
export type ControlCheckReport = z.output<typeof controlCheckReportSchema>;

// The `kind` under which `cupboard push` emits its final summary result. A
// consumer uses this value to find the summary in the reporter's result file.
export const pushSummaryResultKind = 'push-summary';

// A path that failed to resolve, upload, commit or verify. The push presses on
// with the rest, so a failure is reported alongside whatever succeeded, not in
// place of it. The `resolve` stage applies when the store no longer holds a
// declared target at metadata-read time.
export const pushFailureSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	storePath: storePathSchema,
	stage: z.enum(['resolve', 'upload', 'commit', 'verify']),
	reason: z.string()
});
export type PushFailure = z.output<typeof pushFailureSchema>;

// One path's publication outcome and retention result. `already-present` means
// the path was committed before this push. `committed` means a fresh upload or a
// reused blob completed. `pending` means `--no-wait` returned before background
// verification completed. `collected` means the store removed an intermediate
// before its metadata or NAR could be read. `grace` contains `retainUntil` for a
// committed path or `graceSeconds` while a pending path has no deadline. When
// grace reporting is enabled, `{}` means that no policy matched. The property is
// omitted for collected paths and for legacy responses that do not report grace
// facts.
export const pushSummaryPathSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	storePath: storePathSchema.optional(),
	outcome: z.enum(['committed', 'already-present', 'pending', 'collected']),
	grace: uploadGraceFactSchema.optional()
});
export type PushSummaryPath = z.output<typeof pushSummaryPathSchema>;

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
export type PushSummary = z.output<typeof pushSummarySchema>;

// The `kind` under which `cupboard attest attach` emits its final summary
// result. A consumer uses this value to find the summary in the reporter's
// result file.
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
export type AttestationAttachPath = z.output<
	typeof attestationAttachPathSchema
>;

export const attestationAttachSummarySchema = z.strictObject({
	attached: countSchema,
	reused: countSchema,
	unservable: countSchema,
	uploadedBytes: countSchema,
	paths: z.array(attestationAttachPathSchema)
});
export type AttestationAttachSummary = z.output<
	typeof attestationAttachSummarySchema
>;

// The `kind` under which `cupboard build-push` emits its final summary result.
// A consumer uses this value to find the summary in the reporter's result file.
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
export type BuildSummary = z.output<typeof buildSummarySchema>;

export type CheckDiscrepancyInput = z.input<typeof checkDiscrepancySchema>;
export type CheckReportInput = z.input<typeof checkReportSchema>;
export type ControlCheckReportInput = z.input<typeof controlCheckReportSchema>;
export type VerifyReportInput = z.input<typeof verifyReportSchema>;
export type PushFailureInput = z.input<typeof pushFailureSchema>;
export type PushSummaryPathInput = z.input<typeof pushSummaryPathSchema>;
export type PushSummaryInput = z.input<typeof pushSummarySchema>;
export type AttestationAttachPathInput = z.input<
	typeof attestationAttachPathSchema
>;
export type AttestationAttachSummaryInput = z.input<
	typeof attestationAttachSummarySchema
>;
export type BuildSummaryInput = z.input<typeof buildSummarySchema>;
