import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Nix, type NixValidPathInfo } from '@cupboard/nix';
import { implicitPinName } from '@cupboard/nix-store/retention';
import {
	type Sha256HexDigest,
	sha256HexDigestSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import type {
	AttestationAttachResponse,
	AttestationDecision,
	AttestationNegotiateRequest,
	AttestationNegotiateResponse
} from '@cupboard/protocol/attestations';
import type {
	RootSetBody,
	RootSetResponse,
	RootSummary
} from '@cupboard/protocol/retention';
import {
	type CommitResponse,
	type UploadDecision,
	type UploadNegotiateRequest,
	type UploadNegotiateResponse
} from '@cupboard/protocol/upload';
import {
	formatBytes,
	formatCount,
	type PhaseContext,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import { z } from 'zod';

import { isAbortError } from '../abort.ts';
import type { CommitOptions, CommitTarget } from '../client/client.ts';
import type { CommitSession } from '../client/commit-socket.ts';
import { isStaleUploadError } from '../client/rpc-errors.ts';
import {
	AttestationBundleInvalidError,
	AttestationSubjectNotPushedError,
	AttestationUploadUnavailableError,
	PushIncompleteError,
	PushNarMetadataMismatchError,
	UnexpectedAttestationDecisionError,
	UnexpectedUploadDecisionError,
	UploadVerificationFailedError
} from '../errors.ts';
import { byteStream, countingByteStream } from '../io/byte-stream.ts';
import { compressNarToStream, type NarUploadStream } from '../nix/blob.ts';
import { NarArchive, type NarDigest } from '../nix/nar.ts';
import { prepareStorePathNegotiation } from '../nix/nix-store.ts';

import { runWithConcurrency } from './pool.ts';

export interface PushDependencies {
	readonly nix?: Nix;
	readonly client: PushClient;
	readonly root?: string;
	readonly ttlSeconds?: number;
	// `push` waits by default for deferred uploads to become servable before it
	// records retention, since root activation only admits servable targets.
	// `--no-wait` returns with the deferred uploads still pending.
	readonly wait?: boolean;
	readonly waitTimeoutSeconds?: number;
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
	): Promise<UploadNegotiateResponse>;
	// Streams one NAR's compressed bytes to its staging key. The server derives
	// the file hash and size from the bytes, so the upload carries no metadata.
	uploadNar(r2Key: string, body: ReadableStream<Uint8Array>): Promise<void>;
	commit(target: CommitTarget, options: CommitOptions): Promise<CommitResponse>;
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

const defaultWaitTimeoutSeconds = 600;

export type PushNarArchive =
	ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export type CompressNar = (nar: PushNarArchive) => NarUploadStream;

export interface PushAttestationSource {
	readonly path: string;
}

export type ReadAttestationBundle = (path: string) => Promise<Uint8Array>;

type UploadDecisionOf<A extends UploadDecision['action']> = Extract<
	UploadDecision,
	{ action: A }
>;

// A path that could not be uploaded or committed. The push presses on with the
// rest, then fails as a whole so nothing downstream treats it as finished.
interface PushFailure {
	readonly storePathHash: string;
	readonly storePath: string;
	readonly stage: 'upload' | 'commit';
	readonly reason: string;
}

function failureReason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
		dependencies.ttlSeconds
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
	readonly waitTimeoutSeconds: number;
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

	const negotiation = await reporter.phase(
		'Negotiating with cache',
		async (ctx) => {
			const response = await client.negotiate({
				paths: closure.map((pathInfo) => prepareStorePathNegotiation(pathInfo))
			});
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

			return response;
		}
	);

	if (dependencies.dryRun === true) {
		reportDryRun(reporter, negotiation, retention);
		return;
	}

	const uploadDecisions = negotiation.uploads.filter((item) => isUpload(item));

	// A path that fails to upload or commit is collected here, so the paths that
	// can finish do. The push then fails as a whole (see the end of this
	// function) so the incomplete result is never mistaken for a finished one.
	const failures: PushFailure[] = [];
	const failedUploadIds = new Set<string>();
	const negotiated = indexNegotiatedPaths(closure);
	const storePathByHash = new Map<string, string>(
		closure.map((pathInfo) => [
			StorePath.hash(pathInfo.storePath),
			pathInfo.storePath
		])
	);

	let uploadedBytes = 0;
	const uploadContext: UploadContext = {
		client,
		negotiated,
		createNarArchive,
		compressNar,
		onBytes: (count) => {
			uploadedBytes += count;
		}
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

			await runWithConcurrency(
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
		wait: shouldWait,
		timeoutSeconds: waitTimeoutSeconds
	};
	const session = await client.openCommitSession?.(commitOptions);
	const commitContext: CommitContext = {
		client,
		session,
		negotiated,
		createNarArchive,
		compressNar,
		options: commitOptions
	};
	const commit = await reporter.progress(
		'Committing metadata',
		{ total: commitDecisions.length },
		async (bar) => {
			try {
				const settled = await Promise.allSettled(
					commitDecisions.map(async (decision) => {
						try {
							return await commitNegotiated(decision, commitContext);
						} finally {
							bar.advance(1);
						}
					})
				);

				// Pending uploads are collected by store-path hash, so a re-negotiated
				// upload id still resolves to its path for the retention and
				// attestation gates below.
				const pending: string[] = [];
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

					if (result.value.status === 'pending') {
						pending.push(result.value.storePathHash);
					} else {
						committed += 1;
					}
				}

				bar.fact('committed', formatCount(committed));

				return { pending };
			} finally {
				session?.close();
			}
		}
	);

	// Retention is recorded only over a complete, servable push: a failed path
	// would leave the root pinning a closure that cannot be substituted, and the
	// `--no-wait` deferred case already withholds it for the same reason.
	const isIncomplete = failures.length > 0;
	const shouldDeferRetention =
		isIncomplete || (!shouldWait && commit.pending.length > 0);

	// Attestations cannot attach to a path that did not commit, so skip the
	// failed paths as well as any still awaiting verification.
	const unservableStorePathHashes = new Set<string>(
		failures.map((failure) => failure.storePathHash)
	);
	if (!shouldWait && commit.pending.length > 0) {
		for (const storePathHash of commit.pending) {
			unservableStorePathHashes.add(storePathHash);
		}
	}

	if (isIncomplete) {
		reporter.warn(
			'incomplete',
			`${formatCount(failures.length)} path(s) failed; retention not recorded, re-run cupboard push to finish`
		);
	} else if (!shouldWait && commit.pending.length > 0) {
		reporter.warn(
			'pending verification',
			`${formatCount(commit.pending.length)} path(s) await server-side verification; retention not recorded (omit --no-wait to wait and record it)`
		);
	}

	const attestationRows = await attachPushedAttestations(closure, reporter, {
		client,
		enabled: dependencies.attest ?? true,
		sources: dependencies.attestations ?? [],
		readBundle:
			dependencies.readAttestationBundle ?? defaultReadAttestationBundle,
		pendingStorePathHashes: unservableStorePathHashes
	});

	const retentionRows = shouldDeferRetention
		? []
		: await reporter.phase(
				retention.kind === 'pins'
					? 'Pinning pushed paths'
					: 'Updating retention root',
				(ctx) => recordRetention(retention, client, ctx)
			);

	const uploadedPaths = negotiation.uploads.filter((decision) =>
		isUpload(decision)
	).length;
	const reusedBlobs = negotiation.uploads.filter((decision) =>
		isReusedBlobCommit(decision)
	).length;
	const skipped = negotiation.uploads.filter((decision) =>
		isSkip(decision)
	).length;

	reporter.result({
		kind: 'push-summary',
		data: { uploadedPaths, reusedBlobs, skipped, uploadedBytes, failures },
		rows: [
			{ label: 'Uploaded paths', value: formatCount(uploadedPaths) },
			{ label: 'Already cached', value: formatCount(reusedBlobs) },
			{ label: 'Skipped', value: formatCount(skipped) },
			{ label: 'Bytes uploaded', value: formatBytes(uploadedBytes) },
			...attestationRows,
			...retentionRows,
			...(failures.length > 0
				? [{ label: 'Failed', value: formatCount(failures.length) }]
				: [])
		]
	});

	// The good paths committed, but the push as a whole did not finish: fail
	// loudly and non-zero so nothing downstream treats the cache as complete.
	if (failures.length > 0) {
		throw new PushIncompleteError(
			failures.map((failure) => StorePath.basename(failure.storePath))
		);
	}
}

function reportDryRun(
	reporter: Reporter,
	negotiation: UploadNegotiateResponse,
	retention: RetentionPlan
): void {
	const wouldUpload = negotiation.uploads.filter((decision) =>
		isUpload(decision)
	).length;
	const reusedBlobs = negotiation.uploads.filter((decision) =>
		isReusedBlobCommit(decision)
	).length;
	const skipped = negotiation.uploads.filter((decision) =>
		isSkip(decision)
	).length;

	reporter.result({
		kind: 'push-plan',
		data: { wouldUpload, reusedBlobs, skipped },
		rows: [
			{ label: 'Would upload', value: formatCount(wouldUpload) },
			{ label: 'Already cached', value: formatCount(reusedBlobs) },
			{ label: 'Skipped', value: formatCount(skipped) },
			...retentionPlanRows(retention)
		]
	});
}

function retentionPlanRows(retention: RetentionPlan): ResultRow[] {
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
	readonly pendingStorePathHashes: ReadonlySet<string>;
}

interface PreparedAttestationBundle {
	readonly storePathHash: string;
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
		await runWithConcurrency(
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

		await runWithConcurrency(
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

type RetentionPlan =
	| {
			readonly kind: 'root';
			readonly name: string;
			readonly request: RootRequest;
	  }
	| { readonly kind: 'pins'; readonly requests: readonly RootRequest[] };

function planRetention(
	paths: readonly string[],
	root: string | undefined,
	ttlSeconds: number | undefined
): RetentionPlan {
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

async function recordRetention(
	retention: RetentionPlan,
	client: PushClient,
	ctx: PhaseContext
): Promise<readonly ResultRow[]> {
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

	await runWithConcurrency(
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
		: `expires ${summary.expiresAt}`;
}

function describePinExpiry(summaries: readonly RootSummary[]): string {
	const expiries = summaries
		.map((summary) => summary.expiresAt)
		.filter((expiresAt) => expiresAt !== undefined)
		.toSorted(byCodeUnit);
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
}

// Commits one path over the push's shared session, falling back to a per-path
// commit for a minimal client that opens no session.
function commitVia(
	context: CommitContext,
	target: CommitTarget
): Promise<CommitResponse> {
	if (context.session === undefined) {
		return context.client.commit(target, context.options);
	}

	return context.session.commit(target);
}

function commitTarget(
	decision: UploadDecisionOf<'upload' | 'commit'>
): CommitTarget {
	return {
		uploadId: decision.uploadId,
		storePathHash: decision.storePathHash,
		narHash: decision.narHash
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
): Promise<CommitResponse> {
	try {
		return await commitVia(context, commitTarget(decision));
	} catch (error) {
		if (!isStaleUploadError(error) && !isAbsentVerdict(error)) {
			throw error;
		}

		return redriveExpiredCommit(decision, context);
	}
}

// Re-drives a path whose commit slot was reaped from wherever its fresh decision
// puts it: a reuse commits straight away; a fresh upload re-streams the NAR
// before committing; a path the store now already holds needs nothing. The
// reaped row took its staged bytes with it, so a fresh upload must re-send them.
async function redriveExpiredCommit(
	decision: UploadDecisionOf<'upload' | 'commit'>,
	context: CommitContext
): Promise<CommitResponse> {
	const pathInfo = findNegotiatedPath(context.negotiated, decision);
	const renegotiation = await context.client.negotiate({
		paths: [prepareStorePathNegotiation(pathInfo)]
	});
	const fresh = renegotiation.uploads.at(0);

	if (fresh === undefined) {
		throw new UnexpectedUploadDecisionError(
			decision.storePathHash,
			decision.narHash
		);
	}

	if (isReusedBlobCommit(fresh)) {
		return commitVia(context, commitTarget(fresh));
	}

	if (isSkip(fresh)) {
		return {
			storePathHash: fresh.storePathHash,
			narHash: fresh.narHash,
			status: 'committed'
		};
	}

	// The reaped row took the staged bytes with it, so re-stream the NAR to the
	// fresh staging key before committing. The store path is still in the closure,
	// so nothing local is needed beyond re-reading it.
	const upload = context.compressNar(
		context.createNarArchive(pathInfo.storePath)
	);

	await context.client.uploadNar(fresh.r2Key, upload.body);
	verifyNarMetadata(pathInfo, upload.digest());

	return commitVia(context, commitTarget(fresh));
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
	decision: UploadDecision
): decision is Extract<UploadDecision, { action: 'skip' }> {
	return decision.action === 'skip';
}

function isUpload(
	decision: UploadDecision
): decision is Extract<UploadDecision, { action: 'upload' }> {
	return decision.action === 'upload';
}

function isReusedBlobCommit(
	decision: UploadDecision
): decision is Extract<UploadDecision, { action: 'commit' }> {
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
