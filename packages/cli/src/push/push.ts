import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import pathModule from 'node:path';

import { implicitPinName } from '@cupboard/nix/retention';
import {
	type Sha256HexDigest,
	sha256HexDigestSchema
} from '@cupboard/nix/scalars';
import { StorePath } from '@cupboard/nix/store-path';
import type {
	AttestationAttachResponse,
	AttestationDecision,
	AttestationNegotiateRequest,
	AttestationNegotiateResponse,
	AttestationPrepareResponse
} from '@cupboard/protocol/attestations';
import type {
	RootSetBody,
	RootSetResponse,
	RootSummary
} from '@cupboard/protocol/retention';
import type {
	CommitResponse,
	UploadDecision,
	UploadNegotiateRequest,
	UploadNegotiateResponse,
	UploadPrepareRequest,
	UploadPrepareResponse
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
import {
	AttestationBundleInvalidError,
	AttestationSubjectNotPushedError,
	AttestationUploadUnavailableError,
	PushIncompleteError,
	PushNarMetadataMismatchError,
	UnexpectedAttestationDecisionError,
	UnexpectedUploadDecisionError
} from '../errors.ts';
import { byteStream, countingByteStream } from '../io/byte-stream.ts';
import { readFileByteStream } from '../io/file-stream.ts';
import {
	compressAndHashNarToFile,
	type CompressedAndHashedNarFile,
	type CompressedNarBlob
} from '../nix/blob.ts';
import { NarArchive, type NarDigest } from '../nix/nar.ts';
import { NixDaemonStoreClient } from '../nix/nix-daemon.ts';
import {
	type NixStoreClient,
	type NixValidPathInfo,
	type PreparedStorePath,
	prepareStorePathMetadata,
	prepareStorePathNegotiation
} from '../nix/nix-store.ts';

import { runWithConcurrency } from './pool.ts';

export interface PushDependencies {
	readonly nixStore?: NixStoreClient;
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
	readonly readCompressedNar?: ReadCompressedNar;
	readonly createTemporaryDirectory?: () => Promise<string>;
	readonly removeTemporaryDirectory?: (path: string) => Promise<void>;
	/** How many blob uploads run at once; defaults to {@link defaultUploadConcurrency}. */
	readonly uploadConcurrency?: number;
	/** Report what a push would do, without uploading or committing anything. */
	readonly dryRun?: boolean;
}

export const defaultUploadConcurrency = 6;

/**
 * The client surface a push consumes. The contract-backed conversations
 * (negotiate, prepare, attestations, roots) come from the derived client with
 * the credential and cache bound at construction; the blob upload PUTs to a
 * presigned URL and the commit speaks the WebSocket, so both stay raw.
 */
export interface PushClient {
	negotiate(body: UploadNegotiateRequest): Promise<UploadNegotiateResponse>;
	prepareUpload(
		uploadId: string,
		body: UploadPrepareRequest
	): Promise<UploadPrepareResponse>;
	uploadBlob(upload: PushBlobUpload): Promise<void>;
	commit(target: CommitTarget, options: CommitOptions): Promise<CommitResponse>;
	negotiateAttestations?(
		body: AttestationNegotiateRequest
	): Promise<AttestationNegotiateResponse>;
	prepareAttestation?(uploadId: string): Promise<AttestationPrepareResponse>;
	attachAttestation?(uploadId: string): Promise<AttestationAttachResponse>;
	setRoot(name: string, body: RootSetBody): Promise<RootSetResponse>;
}

const defaultWaitTimeoutSeconds = 600;

export type PushNarArchive =
	| ReadableStream<Uint8Array>
	| AsyncIterable<Uint8Array>;

export type CompressNar = (
	nar: PushNarArchive,
	path: string
) => Promise<CompressedAndHashedNarFile>;

export type ReadCompressedNar = (path: string) => ReadableStream<Uint8Array>;

export interface PushAttestationSource {
	readonly path: string;
}

export type ReadAttestationBundle = (path: string) => Promise<Uint8Array>;

export interface PushBlobUpload {
	readonly r2Key: string;
	readonly uploadUrl: string;
	readonly body: ReadableStream<Uint8Array>;
	readonly contentLength: number;
	readonly headers: Readonly<Record<string, string>>;
}

interface PreparedPushPath {
	readonly metadata: PreparedStorePath;
	readonly blob: CompressedNarBlob;
	readonly compressedPath: string;
}

interface PreparedUpload {
	readonly decision: Extract<UploadDecision, { action: 'upload' }>;
	readonly preparedPath: PreparedPushPath;
	readonly uploadUrl: string;
	readonly uploadHeaders: Readonly<Record<string, string>>;
}

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
	const nixStore = dependencies.nixStore ?? new NixDaemonStoreClient();
	const createNarArchive =
		dependencies.createNarArchive ?? ((storePath) => new NarArchive(storePath));
	const compressNar = dependencies.compressNar ?? compressAndHashNarToFile;
	const readCompressedNar =
		dependencies.readCompressedNar ?? readFileByteStream;
	const createTemporaryDirectory =
		dependencies.createTemporaryDirectory ?? defaultCreateTemporaryDirectory;
	const removeTemporaryDirectory =
		dependencies.removeTemporaryDirectory ?? defaultRemoveTemporaryDirectory;
	const temporaryDirectory = await createTemporaryDirectory();

	try {
		await runPushWithTemporaryDirectory(paths, reporter, {
			...dependencies,
			retention,
			nixStore,
			createNarArchive,
			compressNar,
			readCompressedNar,
			temporaryDirectory,
			wait: dependencies.wait ?? true,
			waitTimeoutSeconds:
				dependencies.waitTimeoutSeconds ?? defaultWaitTimeoutSeconds
		});
	} finally {
		await removeTemporaryDirectory(temporaryDirectory);
	}
}

interface PushRuntimeDependencies {
	readonly nixStore: NixStoreClient;
	readonly client: PushClient;
	readonly retention: RetentionPlan;
	readonly createNarArchive: (storePath: string) => PushNarArchive;
	readonly compressNar: CompressNar;
	readonly readCompressedNar: ReadCompressedNar;
	readonly temporaryDirectory: string;
	readonly wait: boolean;
	readonly waitTimeoutSeconds: number;
	readonly attest?: boolean;
	readonly attestations?: readonly PushAttestationSource[];
	readonly readAttestationBundle?: ReadAttestationBundle;
	readonly uploadConcurrency?: number;
	readonly dryRun?: boolean;
}

async function runPushWithTemporaryDirectory(
	paths: readonly string[],
	reporter: Reporter,
	dependencies: PushRuntimeDependencies
): Promise<void> {
	const {
		nixStore,
		client,
		retention,
		createNarArchive,
		compressNar,
		readCompressedNar,
		wait: shouldWait,
		waitTimeoutSeconds
	} = dependencies;
	const closure = await reporter.phase(
		'Resolving store closure',
		async (ctx) => {
			ctx.fact('roots', formatCount(paths.length));
			const resolved = await nixStore.resolveClosure(paths);
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
	const uploads = await reporter.progress(
		'Preparing missing NARs',
		{ total: uploadDecisions.length },
		async (bar) => {
			bar.fact('paths', formatCount(uploadDecisions.length));
			const preparedUploads = await prepareUploads(
				uploadDecisions,
				closure,
				{
					client,
					createNarArchive,
					compressNar,
					temporaryDirectory: dependencies.temporaryDirectory
				},
				() => {
					bar.advance(1);
				}
			);
			bar.fact('nars', formatCount(preparedUploads.length));

			return preparedUploads;
		}
	);

	// A path that fails to upload or commit is collected here rather than
	// aborting the run, so the paths that can finish do. The push then fails as a
	// whole (see the end of this function) so the incomplete result is never
	// mistaken for a finished one.
	const failures: PushFailure[] = [];
	const failedUploadIds = new Set<string>();
	const storePathByHash = new Map<string, string>(
		closure.map((pathInfo) => [
			StorePath.hash(pathInfo.storePath),
			pathInfo.storePath
		])
	);

	// The bar tracks bytes across every blob; each chunk advances it as it
	// streams, so a single large NAR shows steady movement while it uploads,
	// and concurrent uploads each advance the one bar.
	const totalUploadBytes = uploads.reduce(
		(sum, upload) => sum + upload.preparedPath.blob.fileSize,
		0
	);
	const uploadedBytes = await reporter.progress(
		'Uploading missing blobs',
		{ total: totalUploadBytes },
		async (bar) => {
			const startedAt = Date.now();
			let completedBytes = 0;
			let done = 0;

			const reportBlobs = (): void => {
				bar.fact(
					'blobs',
					`${formatCount(done)}/${formatCount(uploads.length)}`
				);

				const elapsedSeconds = (Date.now() - startedAt) / 1000;

				if (elapsedSeconds > 0 && completedBytes > 0) {
					bar.fact('rate', `${formatBytes(completedBytes / elapsedSeconds)}/s`);
				}
			};

			reportBlobs();

			await runWithConcurrency(
				uploads,
				dependencies.uploadConcurrency ?? defaultUploadConcurrency,
				async (upload) => {
					try {
						await client.uploadBlob({
							r2Key: upload.decision.r2Key,
							uploadUrl: upload.uploadUrl,
							body: countingByteStream(
								readCompressedNar(upload.preparedPath.compressedPath),
								(byteLength) => {
									bar.advance(byteLength);
								}
							),
							contentLength: upload.preparedPath.blob.fileSize,
							headers: upload.uploadHeaders
						});

						completedBytes += upload.preparedPath.blob.fileSize;
						done += 1;
						reportBlobs();
					} catch (error) {
						// A Ctrl-C aborts the whole push; any other failure is this one
						// path's, collected so the rest still upload.
						if (isAbortError(error)) {
							throw error;
						}

						const storePath =
							storePathByHash.get(upload.decision.storePathHash) ??
							upload.decision.storePathHash;
						failedUploadIds.add(upload.decision.uploadId);
						failures.push({
							storePathHash: upload.decision.storePathHash,
							storePath,
							stage: 'upload',
							reason: failureReason(error)
						});
						bar.warn(
							'upload failed',
							`${StorePath.basename(storePath)}: ${failureReason(error)}`
						);
					}
				}
			);

			return completedBytes;
		}
	);

	// Every commit conversation runs concurrently: deferred uploads park on
	// their sockets and the server's verification pass settles them together,
	// so committing serially would wait one pass per path. With `--no-wait` a
	// deferred upload reports `pending` as soon as it is stored.
	const commitDecisions = negotiation.uploads
		.filter((decision) => isCommittable(decision))
		.filter((decision) => !failedUploadIds.has(decision.uploadId));
	const commit = await reporter.progress(
		'Committing metadata',
		{ total: commitDecisions.length },
		async (bar) => {
			const settled = await Promise.allSettled(
				commitDecisions.map(async (decision) => {
					try {
						return await client.commit(
							{
								uploadId: decision.uploadId,
								storePathHash: decision.storePathHash,
								narHash: decision.narHash
							},
							{ wait: shouldWait, timeoutSeconds: waitTimeoutSeconds }
						);
					} finally {
						bar.advance(1);
					}
				})
			);

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
					pending.push(decision.uploadId);
				} else {
					committed += 1;
				}
			}

			bar.fact('committed', formatCount(committed));

			return { pending };
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
		for (const hash of pendingUploadStorePathHashes(
			negotiation.uploads,
			commit.pending
		)) {
			unservableStorePathHashes.add(hash);
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

		for (const decision of toUpload) {
			if (dependencies.client.prepareAttestation === undefined) {
				throw new AttestationUploadUnavailableError('prepareAttestation');
			}

			const bundle = findAttestationBundle(ready, decision);
			const preparedUpload = await dependencies.client.prepareAttestation(
				decision.uploadId
			);

			await dependencies.client.uploadBlob({
				r2Key: decision.r2Key,
				uploadUrl: preparedUpload.uploadUrl,
				body: byteStream([bundle.bytes]),
				contentLength: bundle.bytes.byteLength,
				headers: preparedUpload.uploadHeaders
			});

			uploadedBytes += bundle.bytes.byteLength;
		}

		uploadStep.success(formatBytes(uploadedBytes));

		const attachStep = log.group('attach');
		let attached = 0;

		for (const decision of toUpload) {
			if (dependencies.client.attachAttestation === undefined) {
				throw new AttestationUploadUnavailableError('attachAttestation');
			}

			await dependencies.client.attachAttestation(decision.uploadId);
			attached += 1;
		}

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

function pendingUploadStorePathHashes(
	decisions: readonly UploadDecision[],
	pendingUploadIds: readonly string[]
): Set<string> {
	const pending = new Set(pendingUploadIds);
	const storePathHashes = new Set<string>();

	for (const decision of decisions) {
		if (!isCommittable(decision) || !pending.has(decision.uploadId)) {
			continue;
		}

		storePathHashes.add(decision.storePathHash);
	}

	return storePathHashes;
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

	const summaries: RootSummary[] = [];

	for (const { name, body } of retention.requests) {
		summaries.push(await client.setRoot(name, body));
	}

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

function compareStrings(left: string, right: string): number {
	if (left < right) {
		return -1;
	}

	if (left > right) {
		return 1;
	}

	return 0;
}

function describePinExpiry(summaries: readonly RootSummary[]): string {
	const expiries = summaries
		.map((summary) => summary.expiresAt)
		.filter((expiresAt) => expiresAt !== undefined)
		.toSorted(compareStrings);
	const earliest = expiries.at(0);
	const latest = expiries.at(-1);

	if (earliest === undefined || latest === undefined) {
		return 'permanent';
	}

	return earliest === latest
		? `expires ${earliest}`
		: `expires ${earliest} to ${latest}`;
}

interface PreparePushPathDependencies {
	readonly createNarArchive: (storePath: string) => PushNarArchive;
	readonly compressNar: CompressNar;
	readonly temporaryDirectory: string;
}

interface PrepareUploadsDependencies extends PreparePushPathDependencies {
	readonly client: PushClient;
}

async function prepareUploads(
	decisions: readonly Extract<UploadDecision, { action: 'upload' }>[],
	closure: readonly NixValidPathInfo[],
	dependencies: PrepareUploadsDependencies,
	onPrepared?: () => void
): Promise<readonly PreparedUpload[]> {
	const uploads: PreparedUpload[] = [];

	for (const decision of decisions) {
		const pathInfo = findNegotiatedPath(closure, decision);
		const preparedPath = await preparePushPath(pathInfo, dependencies);
		const upload = await dependencies.client.prepareUpload(decision.uploadId, {
			fileHash: preparedPath.blob.fileHash.toString(),
			fileSize: preparedPath.blob.fileSize,
			compression: preparedPath.blob.compression
		});

		uploads.push({
			decision,
			preparedPath,
			uploadUrl: upload.uploadUrl,
			uploadHeaders: upload.uploadHeaders
		});

		onPrepared?.();
	}

	return uploads;
}

async function preparePushPath(
	pathInfo: NixValidPathInfo,
	dependencies: PreparePushPathDependencies
): Promise<PreparedPushPath> {
	const nar = dependencies.createNarArchive(pathInfo.storePath);
	const compressed = await dependencies.compressNar(
		nar,
		pathModule.join(
			dependencies.temporaryDirectory,
			`${StorePath.hash(pathInfo.storePath)}.nar.zst`
		)
	);
	const verifiedPathInfo = verifyNarMetadata(pathInfo, compressed.narDigest);

	return {
		metadata: prepareStorePathMetadata(
			verifiedPathInfo,
			compressed.compressed.blob
		),
		blob: compressed.compressed.blob,
		compressedPath: compressed.compressed.path
	};
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

function findNegotiatedPath(
	closure: readonly NixValidPathInfo[],
	decision: Extract<UploadDecision, { action: 'upload' }>
): NixValidPathInfo {
	const pathInfo = closure.find(
		(item) =>
			StorePath.hash(item.storePath) === decision.storePathHash &&
			item.narHash.toString() === decision.narHash
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

function isCommittable(
	decision: UploadDecision
): decision is Extract<UploadDecision, { action: 'commit' | 'upload' }> {
	return decision.action !== 'skip';
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

function defaultCreateTemporaryDirectory(): Promise<string> {
	return mkdtemp(pathModule.join(tmpdir(), 'cupboard-push-'));
}

function defaultRemoveTemporaryDirectory(path: string): Promise<void> {
	return rm(path, { force: true, recursive: true });
}
