import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Nix, type NixValidPathInfo } from '@cupboard/nix';
import { implicitPinName } from '@cupboard/nix-store/retention';
import {
	type RootName,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StorePathHash,
	type StorePathString,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import type {
	AttestationAttachResponse,
	AttestationDecision,
	AttestationNegotiateRequest,
	AttestationNegotiateResponse
} from '@cupboard/protocol/attestations';
import {
	type PushSummaryPath,
	pushSummaryResultKind,
	pushSummarySchema
} from '@cupboard/protocol/reports';
import {
	type RootSetBody,
	rootSetMaxTargets,
	type RootSetResponse,
	type RootSummary
} from '@cupboard/protocol/retention';
import {
	type ParsedUploadDecision,
	type ParsedUploadNegotiateResponse,
	type ParsedUploadPreviewDecision,
	type ParsedUploadPreviewResponse,
	type UploadNegotiateRequest,
	type UploadPreviewRequest
} from '@cupboard/protocol/upload';
import {
	formatBytes,
	formatCount,
	formatTimestamp,
	type PhaseContext,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { UsageError } from '@cupboard/shared/errors';
import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { isAbortError } from '../abort.ts';
import type { CommitOptions, CommitTarget } from '../client/client.ts';
import type { CommitOutcome, CommitSession } from '../client/commit-socket.ts';
import { isStaleUploadError } from '../client/rpc-errors.ts';
import {
	type WaitTimeoutSeconds,
	waitTimeoutSecondsSchema
} from '../duration.ts';
import {
	AttestationBundleInvalidError,
	AttestationDivergedPathError,
	AttestationSubjectNotPushedError,
	AttestationUploadUnavailableError,
	PushIncompleteError,
	PushNarMetadataMismatchError,
	UnexpectedAttestationDecisionError,
	UnexpectedUploadDecisionError,
	UploadGraceFactsUnsupportedError,
	UploadVerificationFailedError
} from '../errors.ts';
import { byteStream, countingByteStream } from '../io/byte-stream.ts';
import { compressNarToStream, type NarUploadStream } from '../nix/blob.ts';
import { NarArchive, type NarDigest } from '../nix/nar.ts';
import { prepareStorePathNegotiation } from '../nix/nix-store.ts';

export interface PushDependencies {
	readonly nix?: Nix;
	readonly client: PushClient;
	readonly root?: RootName;
	readonly ttlSeconds?: TtlSeconds;
	// Whether this push retains what it publishes at all. Absent (or true) keeps
	// today's behaviour: a named root with `root`, or an implicit pin per path
	// otherwise. `false` is `--no-retain`: no root RPCs at all, so a path is kept
	// only by whatever retention grace policy the cache has configured.
	readonly retain?: boolean;
	// `push` waits by default for deferred uploads to become servable before it
	// records retention, since root activation only admits servable targets.
	// `--no-wait` returns with the deferred uploads still pending.
	readonly wait?: boolean;
	readonly waitTimeoutSeconds?: WaitTimeoutSeconds;
	readonly signal?: AbortSignal;
	readonly attest?: boolean;
	readonly attestations?: readonly PushAttestationSource[];
	readonly readAttestationBundle?: ReadAttestationBundle;
	readonly createNarArchive?: (storePath: string) => PushNarArchive;
	readonly compressNar?: CompressNar;
	/** How many NARs compress and upload at once; defaults to {@link defaultUploadConcurrency}. */
	readonly uploadConcurrency?: number;
	/** Report what a push would do, without uploading or committing anything. */
	readonly dryRun?: boolean;
}

// Each upload streams one NAR's compression into its R2 PUT, a CPU-bound zstd
// pass overlapped with network, so running several at once keeps the phase from
// walking the closure one NAR at a time.
export const defaultUploadConcurrency = 6;

/**
 * The client surface a push consumes. The contract-backed conversations
 * (negotiate, attestations, roots) come from the derived client with the
 * credential and cache bound at construction; the blob upload streams its
 * compressed bytes straight to R2 with the push's temporary credential, and the
 * commit speaks the WebSocket, so both stay raw.
 */
export interface PushClient {
	negotiate(
		body: Omit<UploadNegotiateRequest, 'pushId'>
	): Promise<ParsedUploadNegotiateResponse>;
	// The read-only twin `--dry-run` drives instead of negotiate: no pushId to
	// carry, since a dry run never requests an upload credential.
	preview(body: UploadPreviewRequest): Promise<ParsedUploadPreviewResponse>;
	// A no-path request checks whether the server acknowledges grace-aware
	// upload reporting without creating upload state.
	probeUploadGraceFacts?(kind: 'negotiate' | 'preview'): Promise<boolean>;
	// Whether the most recent upload response acknowledged grace-aware
	// reporting. Clients without transport metadata are treated as capable.
	hasUploadGraceFacts?(): boolean;
	// Whether the tenant answers at all, probed on a route every server
	// version serves, so a routing-level 404 is never mistaken for a missing
	// preview route.
	tenantServes?(): Promise<boolean>;
	// Streams one NAR's compressed bytes to its staging key. The server derives
	// the file hash and size from the bytes, so the upload carries no metadata.
	uploadNar(r2Key: string, body: ReadableStream<Uint8Array>): Promise<void>;
	commit(target: CommitTarget, options: CommitOptions): Promise<CommitOutcome>;
	// Opens one commit session for the whole push. Optional so a minimal client
	// can rely on the per-path `commit`; the push uses it when present to commit
	// every path over a single socket.
	openCommitSession?(options: CommitOptions): Promise<CommitSession>;
	negotiateAttestations?(
		body: Omit<AttestationNegotiateRequest, 'pushId'>
	): Promise<AttestationNegotiateResponse>;
	attachAttestation?(uploadId: string): Promise<AttestationAttachResponse>;
	setRoot(name: string, body: RootSetBody): Promise<RootSetResponse>;
}

const defaultWaitTimeoutSeconds = waitTimeoutSecondsSchema.parse(600);

export type PushNarArchive =
	ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export type CompressNar = (nar: PushNarArchive) => NarUploadStream;

export interface PushAttestationSource {
	readonly path: string;
}

export type ReadAttestationBundle = (path: string) => Promise<Uint8Array>;

type UploadDecisionOf<A extends ParsedUploadDecision['action']> = Extract<
	ParsedUploadDecision,
	{ action: A }
>;

// A path that could not be uploaded or committed. The push presses on with the
// rest, then fails as a whole so nothing downstream treats it as finished.
interface PushFailure {
	readonly storePathHash: StorePathHash;
	readonly storePath: string;
	readonly stage: 'upload' | 'commit' | 'verify';
	readonly reason: string;
}

function failureReason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const notFoundStatus: number = StatusCodes.NOT_FOUND;

async function requireUploadGraceFacts(
	client: PushClient,
	kind: 'negotiate' | 'preview'
): Promise<void> {
	if (client.probeUploadGraceFacts === undefined) {
		return;
	}

	if (await client.probeUploadGraceFacts(kind)) {
		return;
	}

	throw new UploadGraceFactsUnsupportedError(
		new Error('The server did not acknowledge upload-grace-facts')
	);
}

async function negotiateUpload(
	client: PushClient,
	paths: Omit<UploadNegotiateRequest, 'pushId'>['paths']
): Promise<ParsedUploadNegotiateResponse> {
	return client.negotiate({ paths });
}

// The read-only twin of `negotiateUpload`. A server that predates preview
// has no such route at all, so it answers a generic, contract-undefined
// `NOT_FOUND`; other conditions can too, so the rejection is diagnosed
// with the same empty-closure probe negotiate uses: a current server answers
// an empty preview, so only a probe that meets the same undefined `NOT_FOUND`
// reads as too old, and any other probe answer leaves the original failure
// the caller's to see. A defined `NOT_FOUND` would be the procedure itself
// refusing over a missing resource, not a missing route, so it never enters
// the diagnosis. An unknown tenant also answers a routing-level `NOT_FOUND`
// on every route, so before the too-old diagnosis stands, the tenant itself
// must answer something: a tenant that serves `nix-cache-info` but not
// preview is genuinely too old, and one that serves neither surfaces its own
// `NOT_FOUND` untranslated.
async function previewUpload(
	client: PushClient,
	paths: UploadPreviewRequest['paths']
): Promise<ParsedUploadPreviewResponse> {
	try {
		return await client.preview({ paths });
	} catch (error) {
		if (
			error instanceof ORPCError &&
			error.status === notFoundStatus &&
			!error.defined
		) {
			try {
				await client.preview({ paths: [] });
			} catch (probeError) {
				if (
					probeError instanceof ORPCError &&
					probeError.status === notFoundStatus &&
					!probeError.defined &&
					(await tenantAnswers(client))
				) {
					throw new UploadGraceFactsUnsupportedError(error);
				}
			}
		}

		throw error;
	}
}

// Whether the tenant answers at all, for the too-old diagnosis above. A probe
// failure is inconclusive, so it reads as not answering and the original
// rejection surfaces instead of a misdiagnosis.
async function tenantAnswers(client: PushClient): Promise<boolean> {
	if (client.tenantServes === undefined) {
		return true;
	}

	try {
		return await client.tenantServes();
	} catch {
		return false;
	}
}

export async function runPush(
	paths: readonly string[],
	reporter: Reporter,
	dependencies: PushDependencies
): Promise<void> {
	// Validate the retention before any upload work: an invalid root name or
	// target must fail fast, not after NARs are built and committed.
	const retention = planRetention(
		paths,
		dependencies.root,
		dependencies.ttlSeconds,
		dependencies.retain ?? true
	);
	const nix = dependencies.nix ?? Nix.open();
	const createNarArchive =
		dependencies.createNarArchive ?? ((storePath) => new NarArchive(storePath));
	const compressNar = dependencies.compressNar ?? compressNarToStream;

	await runPushFlow(paths, reporter, {
		...dependencies,
		retention,
		nix,
		createNarArchive,
		compressNar,
		wait: dependencies.wait ?? true,
		waitTimeoutSeconds:
			dependencies.waitTimeoutSeconds ?? defaultWaitTimeoutSeconds
	});
}

interface PushRuntimeDependencies {
	readonly nix: Nix;
	readonly client: PushClient;
	readonly retention: RetentionPlan;
	readonly createNarArchive: (storePath: string) => PushNarArchive;
	readonly compressNar: CompressNar;
	readonly wait: boolean;
	readonly waitTimeoutSeconds: WaitTimeoutSeconds;
	readonly attest?: boolean;
	readonly attestations?: readonly PushAttestationSource[];
	readonly readAttestationBundle?: ReadAttestationBundle;
	readonly uploadConcurrency?: number;
	readonly dryRun?: boolean;
}

async function runPushFlow(
	paths: readonly string[],
	reporter: Reporter,
	dependencies: PushRuntimeDependencies
): Promise<void> {
	const {
		nix,
		client,
		retention,
		createNarArchive,
		compressNar,
		wait: shouldWait,
		waitTimeoutSeconds
	} = dependencies;
	const closure = await reporter.phase(
		'Resolving store closure',
		async (ctx) => {
			ctx.fact('roots', formatCount(paths.length));
			const resolved = await nix.resolveClosure(paths);
			ctx.fact('paths', formatCount(resolved.length));

			return resolved;
		}
	);

	if (dependencies.dryRun === true) {
		await reportDryRun(reporter, client, closure, retention);
		return;
	}

	const { response: negotiation, hasGraceFacts } = await reporter.phase(
		'Negotiating with cache',
		async (ctx) => {
			if (retention.kind === 'none') {
				await requireUploadGraceFacts(client, 'negotiate');
			}

			const response = await negotiateUpload(
				client,
				closure.map((pathInfo) => prepareStorePathNegotiation(pathInfo))
			);
			const uploadCount = response.uploads.filter((decision) =>
				isUpload(decision)
			).length;

			ctx.fact('upload', formatCount(uploadCount));
			ctx.fact(
				'skip',
				formatCount(
					response.uploads.filter((decision) => isSkip(decision)).length
				)
			);

			return {
				response,
				hasGraceFacts: client.hasUploadGraceFacts?.() ?? true
			};
		}
	);

	const divergent = divergentSkips(closure, negotiation.uploads);

	warnDivergentSkips(reporter, divergent);

	const uploadDecisions = negotiation.uploads.filter((item) => isUpload(item));

	// A path that fails to upload or commit is collected here, so the paths that
	// can finish do. The push then fails as a whole (see the end of this
	// function) so the incomplete result is never mistaken for a finished one.
	const failures: PushFailure[] = [];
	const failedUploadIds = new Set<string>();
	const negotiated = indexNegotiatedPaths(closure);
	const storePathByHash = new Map<StorePathHash, string>(
		closure.map((pathInfo) => [
			StorePath.hash(pathInfo.storePath),
			pathInfo.storePath
		])
	);

	let uploadedBytes = 0;
	const onBytes = (count: number): void => {
		uploadedBytes += count;
	};
	const uploadContext: UploadContext = {
		client,
		negotiated,
		createNarArchive,
		compressNar,
		onBytes
	};
	const uploaded: UploadDecisionOf<'upload'>[] = [];

	await reporter.progress(
		'Uploading missing NARs',
		{ total: uploadDecisions.length },
		async (bar) => {
			let done = 0;
			bar.fact(
				'nars',
				`${formatCount(done)}/${formatCount(uploadDecisions.length)}`
			);

			await mapWithConcurrency(
				uploadDecisions,
				dependencies.uploadConcurrency ?? defaultUploadConcurrency,
				async (decision) => {
					try {
						await streamNarUpload(decision, uploadContext);
						uploaded.push(decision);
						done += 1;
					} catch (error) {
						if (isAbortError(error)) {
							throw error;
						}

						const storePath =
							storePathByHash.get(decision.storePathHash) ??
							decision.storePathHash;
						const reason = failureReason(error);
						failedUploadIds.add(decision.uploadId);
						failures.push({
							storePathHash: decision.storePathHash,
							storePath,
							stage: 'upload',
							reason
						});
						bar.warn(
							'upload failed',
							`${StorePath.basename(storePath)}: ${reason}`
						);
					} finally {
						bar.advance(1);
						bar.fact(
							'nars',
							`${formatCount(done)}/${formatCount(uploadDecisions.length)}`
						);
					}
				}
			);
		}
	);

	// Every commit conversation runs concurrently: deferred uploads park on
	// their sockets and the server's verification pass settles them together,
	// so committing serially would wait one pass per path. With `--no-wait` a
	// deferred upload reports `pending` as soon as it is stored. The committable
	// decisions are the uploaded paths and the blobs the negotiation said to
	// reuse.
	const commitDecisions = [
		...uploaded,
		...negotiation.uploads.filter((decision) => isReusedBlobCommit(decision))
	].filter((decision) => !failedUploadIds.has(decision.uploadId));
	const commitOptions: CommitOptions = {
		timeoutSeconds: waitTimeoutSeconds
	};
	const session = await client.openCommitSession?.(commitOptions);
	// Keyed by store-path hash, refined in place as a deferred path settles or
	// re-drives, so the push summary reads each path's latest outcome once every
	// phase below has run.
	const outcomes = new Map<StorePathHash, CommitOutcome>();
	// Keyed by store-path hash: the action each path's latest negotiation
	// chose. A re-drive renegotiates, and the fresh decision can differ from
	// the first (a reaped reuse may need a real upload), so the summary
	// counts read these rather than the initial decisions.
	const effectiveActions = new Map<string, ParsedUploadDecision['action']>(
		negotiation.uploads.map((decision) => [
			decision.storePathHash,
			decision.action
		])
	);
	const commitContext: CommitContext = {
		client,
		session,
		negotiated,
		createNarArchive,
		compressNar,
		options: commitOptions,
		hasGraceFacts,
		onBytes,
		onRedriven: (fresh) => {
			effectiveActions.set(fresh.storePathHash, fresh.action);
		}
	};

	try {
		const commit = await reporter.progress(
			'Committing metadata',
			{ total: commitDecisions.length },
			async (bar) => {
				const settled = await Promise.allSettled(
					commitDecisions.map(async (decision) => {
						try {
							return await commitNegotiated(decision, commitContext);
						} finally {
							bar.advance(1);
						}
					})
				);

				// A pending path is committed (its row is reserved) but not yet
				// servable; its `settled` promise carries the verdict the wait phase
				// awaits, and its decision lets the wait phase re-drive an `absent`
				// verdict. Collected by store-path hash, so a re-negotiated upload id
				// still resolves to its path.
				const pending: {
					decision: UploadDecisionOf<'upload' | 'commit'>;
					storePathHash: StorePathHash;
					settled: Promise<void>;
				}[] = [];
				let committed = 0;

				for (const [index, result] of settled.entries()) {
					const decision = commitDecisions[index];

					if (decision === undefined) {
						continue;
					}

					if (result.status === 'rejected') {
						if (isAbortError(result.reason)) {
							throw result.reason;
						}

						const storePath =
							storePathByHash.get(decision.storePathHash) ??
							decision.storePathHash;
						const reason = failureReason(result.reason);
						failures.push({
							storePathHash: decision.storePathHash,
							storePath,
							stage: 'commit',
							reason
						});
						bar.warn(
							'commit failed',
							`${StorePath.basename(storePath)}: ${reason}`
						);
						continue;
					}

					outcomes.set(result.value.storePathHash, result.value);

					if (result.value.status === 'pending') {
						pending.push({
							decision,
							storePathHash: result.value.storePathHash,
							settled: result.value.settled
						});
					} else {
						committed += 1;
					}
				}

				bar.fact('committed', formatCount(committed));

				return { pending };
			}
		);

		// Retention is recorded over every committed path, including one still
		// verifying: a reserved row backs it, so the root binds now and does not
		// depend on the client surviving the wait. Only a hard commit failure
		// withholds it, since such a path has no row to reference.
		const isIncomplete = failures.length > 0;

		if (isIncomplete) {
			reporter.warn(
				'incomplete',
				`${formatCount(failures.length)} path(s) failed to commit; retention not recorded, re-run cupboard push to finish`
			);
		}

		const retentionRows = isIncomplete
			? []
			: await reporter.phase(retentionPhaseLabel(retention), (ctx) =>
					recordRetention(retention, client, ctx)
				);

		// Retention is durable now, so the wait only reports the verdicts: it fails
		// the push loudly if a deferred path fails verification. `--no-wait` leaves
		// them to settle server-side and reports them pending.
		if (shouldWait && commit.pending.length > 0) {
			await reporter.progress(
				'Verifying uploads',
				{ total: commit.pending.length },
				async (bar) => {
					const verdicts = await Promise.allSettled(
						commit.pending.map(async (entry) => {
							try {
								await awaitDeferredVerdict(entry, commitContext, outcomes);
							} finally {
								bar.advance(1);
							}
						})
					);

					for (const [index, result] of verdicts.entries()) {
						const entry = commit.pending[index];

						if (entry === undefined || result.status === 'fulfilled') {
							continue;
						}

						if (isAbortError(result.reason)) {
							throw result.reason;
						}

						const storePath =
							storePathByHash.get(entry.storePathHash) ?? entry.storePathHash;
						const reason = failureReason(result.reason);
						failures.push({
							storePathHash: entry.storePathHash,
							storePath,
							stage: 'verify',
							reason
						});
						bar.warn(
							'verification failed',
							`${StorePath.basename(storePath)}: ${reason}`
						);
					}
				}
			);
		}

		// Attestations attach only to a committed narinfo row, so they run after the
		// wait, once a deferred path has verified and materialised. A path that
		// failed (at commit or verification) has no such row, and `--no-wait` leaves
		// its deferred paths pending, so both are skipped.
		const unservableStorePathHashes = new Set<StorePathHash>(
			failures.map((failure) => failure.storePathHash)
		);
		if (!shouldWait) {
			for (const entry of commit.pending) {
				unservableStorePathHashes.add(entry.storePathHash);
			}
		}

		const attestationRows = await attachPushedAttestations(closure, reporter, {
			client,
			enabled: dependencies.attest ?? true,
			sources: dependencies.attestations ?? [],
			readBundle:
				dependencies.readAttestationBundle ?? defaultReadAttestationBundle,
			pendingStorePathHashes: unservableStorePathHashes,
			divergent
		});

		const actions = effectiveActions.values().toArray();
		const uploadedPaths = actions.filter(
			(action) => action === 'upload'
		).length;
		const reusedBlobs = actions.filter((action) => action === 'commit').length;
		const skipped = actions.filter((action) => action === 'skip').length;
		const failedStorePathHashes = new Set(
			failures.map((failure) => failure.storePathHash)
		);
		const summaryPaths: PushSummaryPath[] = [
			...negotiation.uploads
				.filter((decision) => isSkip(decision))
				.map((decision) => ({
					storePathHash: decision.storePathHash,
					storePath: storePathByHash.get(decision.storePathHash),
					outcome: 'already-present' as const,
					...(decision.grace !== undefined && { grace: decision.grace })
				})),
			...outcomes
				.entries()
				.filter(([storePathHash]) => !failedStorePathHashes.has(storePathHash))
				.map(([storePathHash, outcome]) =>
					committedOrPendingPath(
						storePathHash,
						outcome,
						shouldWait,
						storePathByHash
					)
				)
		];
		const summary = {
			uploadedPaths,
			reusedBlobs,
			skipped,
			uploadedBytes,
			failures,
			paths: summaryPaths
		};
		// The summary is locally assembled, but a non-conforming server can
		// contribute a failure entry the schema refuses (a bare hash as its
		// store path, say); the report must still render and the push must
		// still fail on its real error, so a validation failure downgrades to
		// the unvalidated shape.
		const validated = pushSummarySchema.safeParse(summary);

		reporter.result({
			kind: pushSummaryResultKind,
			data: validated.success ? validated.data : summary,
			rows: [
				{ label: 'Uploaded paths', value: formatCount(uploadedPaths) },
				{ label: 'Already cached', value: formatCount(reusedBlobs) },
				{ label: 'Skipped', value: formatCount(skipped) },
				{ label: 'Bytes uploaded', value: formatBytes(uploadedBytes) },
				...attestationRows,
				...retentionRows,
				...pushSummaryPathRows(summaryPaths, retention),
				...(failures.length > 0
					? [{ label: 'Failed', value: formatCount(failures.length) }]
					: [])
			]
		});
		unretainedUngracedWarning(reporter, retention, summaryPaths);

		// The good paths committed, but the push as a whole did not finish: fail
		// loudly and non-zero so nothing downstream treats the cache as complete.
		if (failures.length > 0) {
			throw new PushIncompleteError(
				failures.map((failure) => StorePath.basename(failure.storePath))
			);
		}
	} finally {
		session?.close();
	}
}

async function reportDryRun(
	reporter: Reporter,
	client: PushClient,
	closure: readonly NixValidPathInfo[],
	retention: RetentionPlan
): Promise<void> {
	const preview = await reporter.phase(
		'Previewing against cache',
		async (ctx) => {
			if (retention.kind === 'none') {
				await requireUploadGraceFacts(client, 'preview');
			}

			const response = await previewUpload(
				client,
				closure.map((pathInfo) => prepareStorePathNegotiation(pathInfo))
			);

			ctx.fact(
				'upload',
				formatCount(
					response.uploads.filter((decision) => decision.action === 'upload')
						.length
				)
			);
			ctx.fact(
				'skip',
				formatCount(
					response.uploads.filter((decision) => decision.action === 'skip')
						.length
				)
			);

			return response;
		}
	);

	warnDivergentSkips(reporter, divergentSkips(closure, preview.uploads));

	const wouldUpload = preview.uploads.filter(
		(decision) => decision.action === 'upload'
	).length;
	const reusedBlobs = preview.uploads.filter(
		(decision) => decision.action === 'commit'
	).length;
	const skipped = preview.uploads.filter(
		(decision) => decision.action === 'skip'
	).length;

	reporter.result({
		kind: 'push-plan',
		data: { wouldUpload, reusedBlobs, skipped, paths: preview.uploads },
		rows: [
			{ label: 'Would upload', value: formatCount(wouldUpload) },
			{ label: 'Already cached', value: formatCount(reusedBlobs) },
			{ label: 'Skipped', value: formatCount(skipped) },
			...retentionPlanRows(retention),
			...previewPathRows(preview.uploads, retention)
		]
	});
	unretainedUngracedWarning(reporter, retention, preview.uploads);
}

// The wording a mutating push's committed and already-present rows use, and
// the dry run's already-cached rows: `retainUntil` is a materialised
// deadline, so it is reported as a fact rather than a projection.
function graceRetainUntilRow(retainUntil: string): string {
	return `kept until ${formatTimestamp(retainUntil)}`;
}

function pushSummaryPathRow(path: PushSummaryPath): ResultRow {
	if (path.grace?.retainUntil !== undefined) {
		return {
			label: path.storePathHash,
			value: graceRetainUntilRow(path.grace.retainUntil)
		};
	}

	const graceSeconds = path.grace?.graceSeconds;

	if (graceSeconds !== undefined && graceSeconds > 0) {
		return {
			label: path.storePathHash,
			value:
				path.outcome === 'pending'
					? `pending (grace ${formatCount(graceSeconds)}s)`
					: `captured grace ${formatCount(graceSeconds)}s`
		};
	}

	if (graceSeconds === 0) {
		return { label: path.storePathHash, value: zeroGraceRow };
	}

	return {
		label: path.storePathHash,
		value: 'no retention grace policy matched'
	};
}

// One row per path, naming its retention grace fact. For a rooted or pinned
// push the rows only render once the push shows at least one fact: an
// ungraced cache (the common case) would otherwise pad the report with a
// "no retention grace policy matched" row per path for no benefit. An
// unretained push always renders them, because grace is the only thing that
// would keep its paths: all-ungraced is exactly what the user must see. The
// JSON `data.paths` carries the full per-path facts unconditionally either
// way, for a consumer that always wants them.
function pushSummaryPathRows(
	paths: readonly PushSummaryPath[],
	retention: RetentionPlan
): readonly ResultRow[] {
	if (
		retention.kind !== 'none' &&
		paths.every((path) => !hasGraceFact(path.grace))
	) {
		return [];
	}

	return cappedPathRows(paths.map((path) => pushSummaryPathRow(path)));
}

// The human report caps the per-path rows; the JSON output always lists
// every path.
const maxPathRows = 20;

function cappedPathRows(rows: readonly ResultRow[]): readonly ResultRow[] {
	if (rows.length <= maxPathRows) {
		return rows;
	}

	return [
		...rows.slice(0, maxPathRows),
		{
			label: '…',
			value: `${formatCount(rows.length - maxPathRows)} more path(s); the full list is in the JSON output`
		}
	];
}

// The wording a matched zero-grace policy earns wherever a fact renders: the
// policy exists, but it retains nothing.
const zeroGraceRow = 'matched a zero-grace policy; nothing retains it';

// The warning an unretained push earns when no path resolved a positive grace
// fact: nothing retains what it just published. A matched zero-grace policy
// still retains nothing, but it is named as such rather than as no policy.
function unretainedUngracedWarning(
	reporter: Reporter,
	retention: RetentionPlan,
	paths: readonly {
		grace?: { retainUntil?: string; graceSeconds?: number };
	}[]
): void {
	if (retention.kind !== 'none') {
		return;
	}

	const hasPositiveFact = paths.some(
		(path) =>
			path.grace?.retainUntil !== undefined ||
			(path.grace?.graceSeconds ?? 0) > 0
	);

	if (hasPositiveFact) {
		return;
	}

	const isZeroMatched = paths.some((path) => path.grace?.graceSeconds === 0);

	reporter.warn(
		'unretained',
		isZeroMatched
			? 'a zero-grace retention policy matched these paths; nothing retains them and the next collection can remove them'
			: 'no retention grace policy matched these paths; nothing retains them and the next collection can remove them'
	);
}

function hasGraceFact(
	grace: { retainUntil?: string; graceSeconds?: number } | undefined
): boolean {
	return grace?.retainUntil !== undefined || grace?.graceSeconds !== undefined;
}

// A dry run never commits anything, so `commit`/`upload` decisions carry only
// the grace a real push would capture, never a materialised deadline; a
// `skip` decision (an already-published path) reports the deadline already
// stored, unstretched, or the policy the cache resolves when none is stored
// yet, which a real push's already-present decision would extend into a
// deadline.
function previewPathRow(decision: ParsedUploadPreviewDecision): ResultRow {
	if (decision.grace?.retainUntil !== undefined) {
		return {
			label: decision.storePathHash,
			value: graceRetainUntilRow(decision.grace.retainUntil)
		};
	}

	const graceSeconds = decision.grace?.graceSeconds;

	if (graceSeconds !== undefined && graceSeconds > 0) {
		return {
			label: decision.storePathHash,
			value:
				decision.action === 'skip'
					? `a push would extend its grace ${formatCount(graceSeconds)}s`
					: `would capture grace ${formatCount(graceSeconds)}s`
		};
	}

	if (graceSeconds === 0) {
		return { label: decision.storePathHash, value: zeroGraceRow };
	}

	return {
		label: decision.storePathHash,
		value: 'no retention grace policy matched'
	};
}

// The dry-run twin of `pushSummaryPathRows`, gated the same way: only once
// the preview shows at least one path with a grace fact, except for an
// unretained plan, whose rows always render.
function previewPathRows(
	decisions: readonly ParsedUploadPreviewDecision[],
	retention: RetentionPlan
): readonly ResultRow[] {
	if (
		retention.kind !== 'none' &&
		decisions.every((decision) => !hasGraceFact(decision.grace))
	) {
		return [];
	}

	return cappedPathRows(decisions.map((decision) => previewPathRow(decision)));
}

// Resolves one committed or deferred path's final outcome and grace fact for
// the push summary. A deferred path resolves to `committed` only once the
// wait phase actually awaited its verdict; `--no-wait` leaves it `pending`
// with the grace it captured at commit time, since its deadline is not yet
// known.
function committedOrPendingPath(
	storePathHash: StorePathHash,
	outcome: CommitOutcome,
	shouldWait: boolean,
	storePathByHash: ReadonlyMap<StorePathHash, string>
): PushSummaryPath {
	const isFinal = outcome.status !== 'pending' || shouldWait;
	const grace = isFinal
		? (outcome.settledGrace?.() ?? outcome.grace)
		: outcome.grace;

	return {
		storePathHash,
		storePath: storePathByHash.get(storePathHash),
		outcome:
			outcome.status === 'already-present'
				? 'already-present'
				: isFinal
					? 'committed'
					: 'pending',
		...(grace !== undefined && { grace })
	};
}

function retentionPlanRows(retention: RetentionPlan): ResultRow[] {
	if (retention.kind === 'none') {
		return [{ label: 'Retention', value: noRetainLabel }];
	}

	if (retention.kind === 'root') {
		return [
			{ label: 'Would set root', value: retention.name },
			{
				label: 'Root expiry',
				value: planExpiry(retention.request.body.ttlSeconds)
			}
		];
	}

	return [
		{ label: 'Would pin paths', value: formatCount(retention.requests.length) },
		{
			label: 'Pin expiry',
			value: planExpiry(retention.requests[0]?.body.ttlSeconds)
		}
	];
}

function planExpiry(ttlSeconds: number | undefined): string {
	return ttlSeconds === undefined
		? 'permanent'
		: `expires after ${formatCount(ttlSeconds)}s`;
}

interface AttachAttestationsDependencies {
	readonly client: PushClient;
	readonly enabled: boolean;
	readonly sources: readonly PushAttestationSource[];
	readonly readBundle: ReadAttestationBundle;
	readonly pendingStorePathHashes: ReadonlySet<StorePathHash>;
	readonly divergent: ReadonlyMap<StorePathHash, DivergentSkip>;
}

interface PreparedAttestationBundle {
	readonly storePathHash: StorePathHash;
	readonly digest: string;
	readonly bytes: Uint8Array;
}

interface AttestationSummary {
	readonly uploaded: number;
	readonly reused: number;
	readonly deferred: number;
	readonly uploadedBytes: number;
}

async function attachPushedAttestations(
	closure: readonly NixValidPathInfo[],
	reporter: Reporter,
	dependencies: AttachAttestationsDependencies
): Promise<readonly ResultRow[]> {
	if (!dependencies.enabled || dependencies.sources.length === 0) {
		return [];
	}

	return reporter.steps('Attestations', async (log) => {
		const readStep = log.group('read');
		const prepared = await prepareAttestationBundles(closure, dependencies);
		readStep.success(`${formatCount(prepared.length)} bundle(s)`);

		const ready = prepared.filter(
			(bundle) => !dependencies.pendingStorePathHashes.has(bundle.storePathHash)
		);
		const deferred = prepared.length - ready.length;

		if (deferred > 0) {
			log.warn(
				'pending verification',
				`${formatCount(deferred)} attestation bundle(s) describe path(s) still awaiting server-side verification; attachment not recorded`
			);
		}

		if (ready.length === 0) {
			return attestationResultRows({
				uploaded: 0,
				reused: 0,
				deferred,
				uploadedBytes: 0
			});
		}

		if (dependencies.client.negotiateAttestations === undefined) {
			throw new AttestationUploadUnavailableError('negotiateAttestations');
		}

		const negotiateStep = log.group('negotiate');
		const negotiation = await dependencies.client.negotiateAttestations({
			bundles: ready.map((bundle) => ({
				storePathHash: bundle.storePathHash,
				digest: bundle.digest
			}))
		});
		const toUpload = negotiation.bundles.filter((decision) =>
			isAttestationUpload(decision)
		);
		const reused = negotiation.bundles.filter((decision) =>
			isAttestationSkip(decision)
		).length;
		negotiateStep.success(
			`${formatCount(toUpload.length)} to upload, ${formatCount(reused)} reused`
		);

		const uploadStep = log.group('upload');
		let uploadedBytes = 0;

		// The bundles all address the same tenant, so they upload under the same
		// bound as blob uploads; sending them one at a time pays a round-trip per
		// bundle.
		await mapWithConcurrency(
			toUpload,
			defaultUploadConcurrency,
			async (decision) => {
				const bundle = findAttestationBundle(ready, decision);

				// The bundle streams to its staging key under the push prefix with
				// the same credential the NARs use, so there is no separate upload
				// path.
				await dependencies.client.uploadNar(
					decision.r2Key,
					byteStream([bundle.bytes])
				);

				uploadedBytes += bundle.bytes.byteLength;
			}
		);

		uploadStep.success(formatBytes(uploadedBytes));

		const attachStep = log.group('attach');
		let attached = 0;

		await mapWithConcurrency(
			toUpload,
			defaultUploadConcurrency,
			async (decision) => {
				if (dependencies.client.attachAttestation === undefined) {
					throw new AttestationUploadUnavailableError('attachAttestation');
				}

				await dependencies.client.attachAttestation(decision.uploadId);
				attached += 1;
			}
		);

		attachStep.success(`${formatCount(attached)} attached`);

		return attestationResultRows({
			uploaded: attached,
			reused,
			deferred,
			uploadedBytes
		});
	});
}

async function prepareAttestationBundles(
	closure: readonly NixValidPathInfo[],
	dependencies: AttachAttestationsDependencies
): Promise<readonly PreparedAttestationBundle[]> {
	const byNarHash = new Map(
		closure.map((pathInfo) => [pathInfo.narHash.digestHex(), pathInfo])
	);
	const prepared: PreparedAttestationBundle[] = [];
	const seen = new Set<string>();

	for (const source of dependencies.sources) {
		const bytes = await dependencies.readBundle(source.path);
		const parsed = parseAttestationBundle(source.path, bytes);
		const digest = sha256Hex(bytes);

		const matched = parsed.subjectDigests
			.map((subjectDigest) => byNarHash.get(subjectDigest))
			.filter((item) => item !== undefined);

		if (matched.length === 0) {
			throw new AttestationSubjectNotPushedError(
				source.path,
				parsed.subjectDigests
			);
		}

		for (const pathInfo of matched) {
			// The bundle describes the local bytes, but the cache committed a
			// different NAR for this store path, so the attach can never succeed:
			// fail here, before any bundle uploads, with both hashes named.
			const diverged = dependencies.divergent.get(
				StorePath.hash(pathInfo.storePath)
			);

			if (diverged !== undefined) {
				throw new AttestationDivergedPathError(
					diverged.storePath,
					diverged.localNarHash,
					diverged.cacheNarHash
				);
			}

			recordPreparedBundle(pathInfo, digest, bytes, seen, prepared);
		}
	}

	return prepared;
}

function recordPreparedBundle(
	pathInfo: NixValidPathInfo,
	digest: string,
	bytes: Uint8Array,
	seen: Set<string>,
	prepared: PreparedAttestationBundle[]
): void {
	const storePathHash = StorePath.hash(pathInfo.storePath);
	const key = `${storePathHash}\0${digest}`;

	if (seen.has(key)) {
		return;
	}

	seen.add(key);
	prepared.push({ storePathHash, digest, bytes });
}

function attestationResultRows(
	summary: AttestationSummary
): readonly ResultRow[] {
	const status = [
		`${formatCount(summary.uploaded)} attached`,
		`${formatCount(summary.reused)} reused`,
		`${formatCount(summary.deferred)} deferred`
	].join(', ');

	return [
		{ label: 'Attestations', value: status },
		{ label: 'Attestation upload', value: formatBytes(summary.uploadedBytes) }
	];
}

interface RootRequest {
	readonly name: string;
	readonly body: RootSetBody;
}

export class RootTargetLimitError extends UsageError {
	constructor(
		public readonly count: number,
		public readonly limit: number
	) {
		super(
			`the named root would contain ${String(count)} targets, but a root accepts ` +
				`at most ${String(limit)}; split the paths across named roots`
		);
		this.name = 'RootTargetLimitError';
	}
}

// The wording a push reports for `--no-retain`. The CLI cannot see whether the
// cache has a matching retention grace policy, so it makes no claim about one.
const noRetainLabel = 'none (--no-retain)';

type RetentionPlan =
	| {
			readonly kind: 'root';
			readonly name: RootName;
			readonly request: RootRequest;
	  }
	| { readonly kind: 'pins'; readonly requests: readonly RootRequest[] }
	| { readonly kind: 'none' };

function planRetention(
	paths: readonly string[],
	root: RootName | undefined,
	ttlSeconds: TtlSeconds | undefined,
	shouldRetain: boolean
): RetentionPlan {
	if (!shouldRetain) {
		return { kind: 'none' };
	}

	if (root !== undefined && paths.length > rootSetMaxTargets) {
		throw new RootTargetLimitError(paths.length, rootSetMaxTargets);
	}

	const ttlFields = ttlSeconds === undefined ? {} : { ttlSeconds };

	if (root !== undefined) {
		return {
			kind: 'root',
			name: root,
			request: { name: root, body: { targets: [...paths], ...ttlFields } }
		};
	}

	return {
		kind: 'pins',
		requests: paths.map((path) => ({
			name: implicitPinName(StorePath.hash(path)),
			body: { targets: [path], ...ttlFields }
		}))
	};
}

function retentionPhaseLabel(retention: RetentionPlan): string {
	switch (retention.kind) {
		case 'root': {
			return 'Updating retention root';
		}

		case 'pins': {
			return 'Pinning pushed paths';
		}

		case 'none': {
			return 'Recording retention';
		}
	}
}

async function recordRetention(
	retention: RetentionPlan,
	client: PushClient,
	ctx: PhaseContext
): Promise<readonly ResultRow[]> {
	if (retention.kind === 'none') {
		ctx.fact('retention', noRetainLabel);

		return [{ label: 'Retention', value: noRetainLabel }];
	}

	if (retention.kind === 'root') {
		const { name, body } = retention.request;
		const summary = await client.setRoot(name, body);
		const expiry = formatExpiry(summary);
		ctx.fact('root', retention.name);
		ctx.fact('expiry', expiry);

		return [
			{ label: 'Root', value: retention.name },
			{ label: 'Root expiry', value: expiry }
		];
	}

	// Each pin is its own root request to the same tenant, so they are sent under
	// the same bound as blob uploads; the expiry summary folds them
	// order-independently.
	const summaries: RootSummary[] = [];

	await mapWithConcurrency(
		retention.requests,
		defaultUploadConcurrency,
		async ({ name, body }) => {
			summaries.push(await client.setRoot(name, body));
		}
	);

	const expiry = describePinExpiry(summaries);
	ctx.fact('pins', formatCount(retention.requests.length));
	ctx.fact('expiry', expiry);

	return [
		{ label: 'Pinned paths', value: formatCount(retention.requests.length) },
		{ label: 'Pin expiry', value: expiry }
	];
}

function formatExpiry(summary: RootSummary): string {
	return summary.expiresAt === undefined
		? 'permanent'
		: `expires ${formatTimestamp(summary.expiresAt)}`;
}

function describePinExpiry(summaries: readonly RootSummary[]): string {
	// Compared after rendering: expiries that only differ beneath the rendered
	// minute report as one value, not a range of two identical timestamps.
	const expiries = summaries
		.map((summary) => summary.expiresAt)
		.filter((expiresAt) => expiresAt !== undefined)
		.toSorted(byCodeUnit)
		.map((expiresAt) => formatTimestamp(expiresAt));
	const earliest = expiries.at(0);
	const latest = expiries.at(-1);

	if (earliest === undefined || latest === undefined) {
		return 'permanent';
	}

	return earliest === latest
		? `expires ${earliest}`
		: `expires ${earliest} to ${latest}`;
}

interface UploadContext {
	readonly client: PushClient;
	readonly negotiated: NegotiatedPaths;
	readonly createNarArchive: (storePath: string) => PushNarArchive;
	readonly compressNar: CompressNar;
	readonly onBytes: (count: number) => void;
}

// Streams one missing NAR straight to its staging key: the archive is compressed
// on the fly and the compressed bytes go to R2 without ever touching disk, so a
// large closure cannot exhaust a runner's temporary space. The uncompressed hash
// and size, accumulated as the bytes pass through, are checked against what was
// negotiated once the stream drains, so a store path that changed under the push
// is caught before its commit.
async function streamNarUpload(
	decision: UploadDecisionOf<'upload'>,
	context: UploadContext
): Promise<void> {
	const pathInfo = findNegotiatedPath(context.negotiated, decision);
	const upload = context.compressNar(
		context.createNarArchive(pathInfo.storePath)
	);

	await context.client.uploadNar(
		decision.r2Key,
		countingByteStream(upload.body, context.onBytes)
	);
	verifyNarMetadata(pathInfo, upload.digest());
}

interface CommitContext {
	readonly client: PushClient;
	readonly session: CommitSession | undefined;
	readonly negotiated: NegotiatedPaths;
	readonly createNarArchive: (storePath: string) => PushNarArchive;
	readonly compressNar: CompressNar;
	readonly options: CommitOptions;
	readonly hasGraceFacts: boolean;
	readonly onBytes: (count: number) => void;
	readonly onRedriven: (fresh: ParsedUploadDecision) => void;
}

// Commits one path over the push's shared session, falling back to a per-path
// commit for a minimal client that opens no session.
function commitVia(
	context: CommitContext,
	target: CommitTarget
): Promise<CommitOutcome> {
	if (context.session === undefined) {
		return context.client.commit(target, context.options);
	}

	return context.session.commit(target);
}

function commitTarget(
	decision: UploadDecisionOf<'upload' | 'commit'>,
	shouldReportGraceFacts: boolean
): CommitTarget {
	return {
		uploadId: decision.uploadId,
		storePathHash: decision.storePathHash,
		narHash: decision.narHash,
		...(shouldReportGraceFacts && { retention: true as const })
	};
}

// A deferred commit whose verify pass answered `absent`: the row or the
// shared blob it relied on vanished before the verdict could settle it, the
// deferred twin of a `NOT_FOUND` commit. It recovers the same way, by
// planning afresh.
function isAbsentVerdict(error: unknown): boolean {
	return (
		error instanceof UploadVerificationFailedError && error.status === 'absent'
	);
}

// Commits one path, re-negotiating it if what it negotiated is gone by commit
// time. A long upload phase can outlive the slot negotiate stamped, and a
// reused blob can be collected between negotiate and commit; a `NOT_FOUND`
// commit or an `absent` deferred verdict means one of those, not that the
// transfer is dead, so the path is re-driven. The re-drive
// commits without this wrapper, so a second loss propagates.
async function commitNegotiated(
	decision: UploadDecisionOf<'upload' | 'commit'>,
	context: CommitContext
): Promise<CommitOutcome> {
	try {
		return await commitVia(
			context,
			commitTarget(decision, context.hasGraceFacts)
		);
	} catch (error) {
		if (!isStaleUploadError(error) && !isAbsentVerdict(error)) {
			throw error;
		}

		return redriveExpiredCommit(decision, context);
	}
}

// Awaits a deferred path's verdict, recovering an `absent` verdict the way a
// commit-time loss does: renegotiate and re-drive the path, then await the fresh
// verdict. Retention is already recorded over the path, so a successful re-drive
// needs nothing more; a second loss, or any other failure, propagates so the
// wait phase reports it.
async function awaitDeferredVerdict(
	entry: {
		readonly decision: UploadDecisionOf<'upload' | 'commit'>;
		readonly settled: Promise<void>;
	},
	context: CommitContext,
	outcomes: Map<StorePathHash, CommitOutcome>
): Promise<void> {
	try {
		await entry.settled;
	} catch (error) {
		if (isAbortError(error) || !isAbsentVerdict(error)) {
			throw error;
		}

		const redriven = await redriveExpiredCommit(entry.decision, context);
		outcomes.set(redriven.storePathHash, redriven);
		await redriven.settled;
	}
}

// Re-drives a path whose commit slot was reaped from wherever its fresh decision
// puts it: a reuse commits straight away; a fresh upload re-streams the NAR
// before committing; a path the store now already holds needs nothing. The
// reaped row took its staged bytes with it, so a fresh upload must re-send them.
async function redriveExpiredCommit(
	decision: UploadDecisionOf<'upload' | 'commit'>,
	context: CommitContext
): Promise<CommitOutcome> {
	const pathInfo = findNegotiatedPath(context.negotiated, decision);
	const renegotiation = await negotiateUpload(context.client, [
		prepareStorePathNegotiation(pathInfo)
	]);
	const fresh = renegotiation.uploads.at(0);

	if (fresh === undefined) {
		throw new UnexpectedUploadDecisionError(
			decision.storePathHash,
			decision.narHash
		);
	}

	context.onRedriven(fresh);

	if (isReusedBlobCommit(fresh)) {
		return commitVia(context, commitTarget(fresh, context.hasGraceFacts));
	}

	if (isSkip(fresh)) {
		// Already in the store: nothing to verify, so it is servable at once.
		return {
			storePathHash: fresh.storePathHash,
			narHash: fresh.narHash,
			status: 'already-present',
			settled: Promise.resolve(),
			...(fresh.grace !== undefined && { grace: fresh.grace })
		};
	}

	// The reaped row took the staged bytes with it, so re-stream the NAR to the
	// fresh staging key before committing. The store path is still in the closure,
	// so nothing local is needed beyond re-reading it.
	const upload = context.compressNar(
		context.createNarArchive(pathInfo.storePath)
	);

	await context.client.uploadNar(
		fresh.r2Key,
		countingByteStream(upload.body, context.onBytes)
	);
	verifyNarMetadata(pathInfo, upload.digest());

	return commitVia(context, commitTarget(fresh, context.hasGraceFacts));
}

function verifyNarMetadata(
	pathInfo: NixValidPathInfo,
	digest: NarDigest
): NixValidPathInfo {
	const expectedNarHash = pathInfo.narHash.toString();
	const actualNarHash = digest.narHash.toString();

	if (
		expectedNarHash === actualNarHash &&
		pathInfo.narSize === digest.narSize
	) {
		return pathInfo;
	}

	throw new PushNarMetadataMismatchError(
		pathInfo.storePath,
		expectedNarHash,
		actualNarHash,
		pathInfo.narSize,
		digest.narSize
	);
}

// A skip decision whose committed NAR differs from the local path's: the two
// sides realised the same store path with different bytes, so the build is not
// reproducible. The cache keeps its copy, and an attestation over the local
// bytes can never attach to it.
interface DivergentSkip {
	readonly storePath: StorePathString;
	readonly localNarHash: string;
	readonly cacheNarHash: string;
}

function divergentSkips(
	closure: readonly NixValidPathInfo[],
	decisions: readonly (ParsedUploadDecision | ParsedUploadPreviewDecision)[]
): ReadonlyMap<StorePathHash, DivergentSkip> {
	const localByStorePathHash = new Map<StorePathHash, NixValidPathInfo>(
		closure.map((info) => [StorePath.hash(info.storePath), info])
	);
	const divergent = new Map<StorePathHash, DivergentSkip>();

	for (const decision of decisions) {
		if (decision.action !== 'skip') {
			continue;
		}

		const local = localByStorePathHash.get(decision.storePathHash);

		if (local === undefined || local.narHash.toString() === decision.narHash) {
			continue;
		}

		divergent.set(decision.storePathHash, {
			storePath: local.storePath,
			localNarHash: local.narHash.toString(),
			cacheNarHash: decision.narHash
		});
	}

	return divergent;
}

// A skip whose cached NAR differs from the local bytes is not reproducible
// as-is; the mutating push and the dry run warn identically, since the
// preview's skip decisions carry the same cached hash.
function warnDivergentSkips(
	reporter: Reporter,
	divergent: ReadonlyMap<StorePathHash, DivergentSkip>
): void {
	for (const skip of divergent.values()) {
		reporter.warn(
			'divergent',
			`${StorePath.basename(skip.storePath)}: local NAR ${skip.localNarHash} ` +
				`differs from the cached copy ${skip.cacheNarHash}; the cache keeps ` +
				`its copy`
		);
	}
}

// The closure indexed by the pair a negotiation decision names, so resolving a
// decision back to its path is one lookup. Built once: scanning the closure and
// rehashing every store path on every lookup is quadratic across a large push.
type NegotiatedPaths = ReadonlyMap<string, NixValidPathInfo>;

function negotiatedPathKey(storePathHash: string, narHash: string): string {
	return `${storePathHash}\0${narHash}`;
}

function indexNegotiatedPaths(
	closure: readonly NixValidPathInfo[]
): NegotiatedPaths {
	return new Map(
		closure.map((item) => [
			negotiatedPathKey(
				StorePath.hash(item.storePath),
				item.narHash.toString()
			),
			item
		])
	);
}

function findNegotiatedPath(
	negotiated: NegotiatedPaths,
	decision: UploadDecisionOf<'upload' | 'commit'>
): NixValidPathInfo {
	const pathInfo = negotiated.get(
		negotiatedPathKey(decision.storePathHash, decision.narHash)
	);

	if (pathInfo !== undefined) {
		return pathInfo;
	}

	throw new UnexpectedUploadDecisionError(
		decision.storePathHash,
		decision.narHash
	);
}

function isSkip(
	decision: ParsedUploadDecision
): decision is Extract<ParsedUploadDecision, { action: 'skip' }> {
	return decision.action === 'skip';
}

function isUpload(
	decision: ParsedUploadDecision
): decision is Extract<ParsedUploadDecision, { action: 'upload' }> {
	return decision.action === 'upload';
}

function isReusedBlobCommit(
	decision: ParsedUploadDecision
): decision is Extract<ParsedUploadDecision, { action: 'commit' }> {
	return decision.action === 'commit';
}

function isAttestationUpload(
	decision: AttestationDecision
): decision is Extract<AttestationDecision, { action: 'upload' }> {
	return decision.action === 'upload';
}

function isAttestationSkip(
	decision: AttestationDecision
): decision is Extract<AttestationDecision, { action: 'skip' }> {
	return decision.action === 'skip';
}

function findAttestationBundle(
	bundles: readonly PreparedAttestationBundle[],
	decision: Extract<AttestationDecision, { action: 'upload' }>
): PreparedAttestationBundle {
	const bundle = bundles.find(
		(item) =>
			item.storePathHash === decision.storePathHash &&
			item.digest === decision.digest
	);

	if (bundle !== undefined) {
		return bundle;
	}

	throw new UnexpectedAttestationDecisionError(
		decision.storePathHash,
		decision.digest
	);
}

const inTotoPayloadType = 'application/vnd.in-toto+json';
const inTotoStatementType = 'https://in-toto.io/Statement/v1';

const dsseEnvelopeSchema = z.object({
	payload: z.string(),
	payloadType: z.literal(inTotoPayloadType)
});

const sigstoreBundleSubjectSchema = z.object({
	digest: z.object({
		sha256: sha256HexDigestSchema
	})
});

const sigstoreBundleStatementSchema = z.object({
	_type: z.literal(inTotoStatementType),
	subject: z.array(sigstoreBundleSubjectSchema).min(1),
	predicateType: z.string(),
	predicate: z.unknown()
});

const sigstoreBundleSchema = z.object({
	dsseEnvelope: dsseEnvelopeSchema
});

function parseAttestationBundle(
	path: string,
	bytes: Uint8Array
): { readonly subjectDigests: readonly Sha256HexDigest[] } {
	let json: unknown;

	try {
		const decoder = new TextDecoder();
		json = JSON.parse(decoder.decode(bytes));
	} catch {
		throw new AttestationBundleInvalidError(path, 'bundle is not JSON');
	}

	const bundle = sigstoreBundleSchema.safeParse(json);

	if (!bundle.success) {
		throw new AttestationBundleInvalidError(
			path,
			'bundle does not carry a DSSE envelope'
		);
	}

	let statementJson: unknown;

	try {
		statementJson = JSON.parse(
			Buffer.from(bundle.data.dsseEnvelope.payload, 'base64').toString('utf8')
		);
	} catch {
		throw new AttestationBundleInvalidError(
			path,
			'bundle DSSE payload is not JSON'
		);
	}

	const statement = sigstoreBundleStatementSchema.safeParse(statementJson);

	if (!statement.success) {
		throw new AttestationBundleInvalidError(
			path,
			'bundle DSSE payload is not a supported in-toto statement'
		);
	}

	return {
		subjectDigests: statement.data.subject.map(
			(subject) => subject.digest.sha256
		)
	};
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

async function defaultReadAttestationBundle(path: string): Promise<Uint8Array> {
	return readFile(path);
}
