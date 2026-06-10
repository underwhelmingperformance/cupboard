import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import pathModule from 'node:path';

import { implicitPinName } from '@cupboard/nix/retention';
import { sha256HexDigestSchema } from '@cupboard/nix/scalars';
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
	UploadPrepareResponse,
	UploadStatusResponse
} from '@cupboard/protocol/upload';
import {
	formatBytes,
	formatCount,
	type PhaseContext,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import { z } from 'zod';

import type { AccessCredential } from '../client/client.ts';
import {
	AttestationBundleInvalidError,
	AttestationSubjectNotPushedError,
	AttestationUploadUnavailableError,
	PushNarMetadataMismatchError,
	UnexpectedAttestationDecisionError,
	UnexpectedUploadDecisionError,
	UploadVerificationFailedError,
	UploadWaitTimeoutError
} from '../errors.ts';
import { byteStream } from '../io/byte-stream.ts';
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

export interface PushDependencies {
	readonly nixStore?: NixStoreClient;
	readonly client: PushClient;
	readonly token: AccessCredential;
	readonly root?: string;
	readonly ttlSeconds?: number;
	// `push` waits by default for deferred uploads to become servable before it
	// records retention, since root activation only admits servable targets.
	// `--no-wait` returns with the deferred uploads still pending.
	readonly wait?: boolean;
	readonly waitTimeoutSeconds?: number;
	readonly waitPollIntervalMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	readonly attest?: boolean;
	readonly attestations?: readonly PushAttestationSource[];
	readonly readAttestationBundle?: ReadAttestationBundle;
	readonly createNarArchive?: (storePath: string) => PushNarArchive;
	readonly compressNar?: CompressNar;
	readonly readCompressedNar?: ReadCompressedNar;
	readonly createTemporaryDirectory?: () => Promise<string>;
	readonly removeTemporaryDirectory?: (path: string) => Promise<void>;
}

export interface PushClient {
	negotiate(
		token: AccessCredential,
		body: UploadNegotiateRequest
	): Promise<UploadNegotiateResponse>;
	prepareUpload(
		token: AccessCredential,
		uploadId: string,
		body: UploadPrepareRequest
	): Promise<UploadPrepareResponse>;
	uploadBlob(upload: PushBlobUpload): Promise<void>;
	commit(token: AccessCredential, uploadId: string): Promise<CommitResponse>;
	uploadStatus(
		token: AccessCredential,
		uploadId: string
	): Promise<UploadStatusResponse>;
	negotiateAttestations?(
		token: AccessCredential,
		body: AttestationNegotiateRequest
	): Promise<AttestationNegotiateResponse>;
	prepareAttestation?(
		token: AccessCredential,
		uploadId: string
	): Promise<AttestationPrepareResponse>;
	attachAttestation?(
		token: AccessCredential,
		uploadId: string
	): Promise<AttestationAttachResponse>;
	setRoot(
		token: AccessCredential,
		name: string,
		body: RootSetBody
	): Promise<RootSetResponse>;
}

const defaultWaitTimeoutSeconds = 600;
const defaultWaitPollIntervalMs = 2000;

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
			waitOptions: {
				timeoutSeconds:
					dependencies.waitTimeoutSeconds ?? defaultWaitTimeoutSeconds,
				intervalMs:
					dependencies.waitPollIntervalMs ?? defaultWaitPollIntervalMs,
				sleep: dependencies.sleep ?? defaultSleep,
				now: dependencies.now ?? Date.now
			}
		});
	} finally {
		await removeTemporaryDirectory(temporaryDirectory);
	}
}

interface WaitOptions {
	readonly timeoutSeconds: number;
	readonly intervalMs: number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly now: () => number;
}

interface PushRuntimeDependencies {
	readonly nixStore: NixStoreClient;
	readonly client: PushClient;
	readonly token: AccessCredential;
	readonly retention: RetentionPlan;
	readonly createNarArchive: (storePath: string) => PushNarArchive;
	readonly compressNar: CompressNar;
	readonly readCompressedNar: ReadCompressedNar;
	readonly temporaryDirectory: string;
	readonly wait: boolean;
	readonly waitOptions: WaitOptions;
	readonly attest?: boolean;
	readonly attestations?: readonly PushAttestationSource[];
	readonly readAttestationBundle?: ReadAttestationBundle;
}

async function runPushWithTemporaryDirectory(
	paths: readonly string[],
	reporter: Reporter,
	dependencies: PushRuntimeDependencies
): Promise<void> {
	const {
		nixStore,
		client,
		token,
		retention,
		createNarArchive,
		compressNar,
		readCompressedNar,
		wait,
		waitOptions
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
			const response = await client.negotiate(token, {
				paths: closure.map((pathInfo) => prepareStorePathNegotiation(pathInfo))
			});
			const uploadCount = response.uploads.filter((decision) =>
				needsUpload(decision)
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

	const uploads = await reporter.phase(
		'Preparing missing NARs',
		async (ctx) => {
			const decisions = negotiation.uploads.filter((item) => needsUpload(item));
			ctx.fact('paths', formatCount(decisions.length));
			const preparedUploads = await prepareUploads(decisions, closure, {
				client,
				token,
				createNarArchive,
				compressNar,
				temporaryDirectory: dependencies.temporaryDirectory
			});
			ctx.fact('nars', formatCount(preparedUploads.length));

			return preparedUploads;
		}
	);

	const uploadedBytes = await reporter.phase(
		'Uploading missing blobs',
		async (ctx) => {
			let totalUploaded = 0;

			for (const upload of uploads) {
				await client.uploadBlob({
					r2Key: upload.decision.r2Key,
					uploadUrl: upload.uploadUrl,
					body: readCompressedNar(upload.preparedPath.compressedPath),
					contentLength: upload.preparedPath.blob.fileSize,
					headers: upload.uploadHeaders
				});

				totalUploaded += upload.preparedPath.blob.fileSize;
				ctx.fact('uploaded', formatBytes(totalUploaded));
			}

			return totalUploaded;
		}
	);

	const commit = await reporter.phase('Committing metadata', async (ctx) => {
		const decisions = negotiation.uploads.filter((decision) =>
			needsCommit(decision)
		);
		const responses: CommitResponse[] = [];
		const pending: string[] = [];

		for (const decision of decisions) {
			const response = await client.commit(token, decision.uploadId);
			responses.push(response);

			if (response.status === 'pending') {
				pending.push(decision.uploadId);
			}
		}

		ctx.fact(
			'committed',
			formatCount(responses.filter((row) => row.status !== 'pending').length)
		);

		return { responses, pending };
	});

	// A path whose blob exceeds the server's inline-verify budget commits as
	// `pending`: it is stored but not substitutable until the background pass
	// verifies it. `push` waits for those to become servable, because root
	// activation only admits servable targets; `--no-wait` returns with them
	// pending and records no retention over them.
	if (commit.pending.length > 0 && wait) {
		await reporter.phase('Waiting for verification', (ctx) =>
			waitForUploads(client, token, commit.pending, ctx, waitOptions)
		);
	}

	const deferRetention = !wait && commit.pending.length > 0;
	const pendingStorePathHashes = deferRetention
		? pendingUploadStorePathHashes(negotiation.uploads, commit.pending)
		: new Set<string>();

	if (deferRetention) {
		reporter.warn(
			'pending verification',
			`${formatCount(commit.pending.length)} path(s) await server-side verification; retention not recorded (omit --no-wait to wait and record it)`
		);
	}

	const attestationRows = await attachPushedAttestations(closure, reporter, {
		client,
		token,
		enabled: dependencies.attest ?? true,
		sources: dependencies.attestations ?? [],
		readBundle:
			dependencies.readAttestationBundle ?? defaultReadAttestationBundle,
		pendingStorePathHashes
	});

	const retentionRows = deferRetention
		? []
		: await reporter.phase(
				retention.kind === 'pins'
					? 'Pinning pushed paths'
					: 'Updating retention root',
				(ctx) => recordRetention(retention, { client, token }, ctx)
			);

	const uploadedPaths = negotiation.uploads.filter((decision) =>
		needsUpload(decision)
	).length;
	const reusedBlobs = negotiation.uploads.filter((decision) =>
		needsReusedBlobCommit(decision)
	).length;

	reporter.result([
		{ label: 'Uploaded paths', value: formatCount(uploadedPaths) },
		{ label: 'Reused blobs', value: formatCount(reusedBlobs) },
		{
			label: 'Skipped',
			value: formatCount(
				negotiation.uploads.filter((decision) => isSkip(decision)).length
			)
		},
		{ label: 'Uploaded', value: formatBytes(uploadedBytes) },
		...attestationRows,
		...retentionRows
	]);
}

interface AttachAttestationsDependencies {
	readonly client: PushClient;
	readonly token: AccessCredential;
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

	const prepared = await reporter.phase('Reading attestations', async (ctx) => {
		const bundles = await prepareAttestationBundles(closure, dependencies);
		ctx.fact('bundles', formatCount(bundles.length));

		return bundles;
	});

	const ready = prepared.filter(
		(bundle) => !dependencies.pendingStorePathHashes.has(bundle.storePathHash)
	);
	const deferred = prepared.length - ready.length;

	if (deferred > 0) {
		reporter.warn(
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

	const negotiation = await reporter.phase(
		'Negotiating attestations',
		async (ctx) => {
			if (dependencies.client.negotiateAttestations === undefined) {
				throw new AttestationUploadUnavailableError('negotiateAttestations');
			}

			const response = await dependencies.client.negotiateAttestations(
				dependencies.token,
				{
					bundles: ready.map((bundle) => ({
						storePathHash: bundle.storePathHash,
						digest: bundle.digest
					}))
				}
			);
			ctx.fact(
				'upload',
				formatCount(
					response.bundles.filter((decision) =>
						needsAttestationUpload(decision)
					).length
				)
			);
			ctx.fact(
				'skip',
				formatCount(
					response.bundles.filter((decision) => isAttestationSkip(decision))
						.length
				)
			);

			return response;
		}
	);

	const uploaded = await reporter.phase(
		'Uploading attestation bundles',
		async (ctx) => {
			let uploadedBytes = 0;

			for (const decision of negotiation.bundles.filter((item) =>
				needsAttestationUpload(item)
			)) {
				const bundle = findAttestationBundle(ready, decision);
				if (dependencies.client.prepareAttestation === undefined) {
					throw new AttestationUploadUnavailableError('prepareAttestation');
				}

				const preparedUpload = await dependencies.client.prepareAttestation(
					dependencies.token,
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
				ctx.fact('uploaded', formatBytes(uploadedBytes));
			}

			return uploadedBytes;
		}
	);

	const attached = await reporter.phase(
		'Attaching attestation descriptors',
		async (ctx) => {
			let count = 0;

			for (const decision of negotiation.bundles.filter((item) =>
				needsAttestationUpload(item)
			)) {
				if (dependencies.client.attachAttestation === undefined) {
					throw new AttestationUploadUnavailableError('attachAttestation');
				}

				await dependencies.client.attachAttestation(
					dependencies.token,
					decision.uploadId
				);
				count += 1;
				ctx.fact('attached', formatCount(count));
			}

			return count;
		}
	);

	return attestationResultRows({
		uploaded: attached,
		reused: negotiation.bundles.filter((decision) =>
			isAttestationSkip(decision)
		).length,
		deferred,
		uploadedBytes: uploaded
	});
}

async function prepareAttestationBundles(
	closure: readonly NixValidPathInfo[],
	dependencies: AttachAttestationsDependencies
): Promise<readonly PreparedAttestationBundle[]> {
	const byNarHash = new Map(
		closure.map((pathInfo) => [narHashDigestHex(pathInfo.narHash), pathInfo])
	);
	const prepared: PreparedAttestationBundle[] = [];

	for (const source of dependencies.sources) {
		const bytes = await dependencies.readBundle(source.path);
		const parsed = parseAttestationBundle(source.path, bytes);
		const pathInfo = parsed.subjectDigests
			.map((digest) => byNarHash.get(digest))
			.find((item) => item !== undefined);

		if (pathInfo === undefined) {
			throw new AttestationSubjectNotPushedError(
				source.path,
				parsed.subjectDigests
			);
		}

		prepared.push({
			storePathHash: StorePath.hash(pathInfo.storePath),
			digest: sha256Hex(bytes),
			bytes
		});
	}

	return prepared;
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
		if (!needsCommit(decision) || !pending.has(decision.uploadId)) {
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
	dependencies: {
		readonly client: PushClient;
		readonly token: AccessCredential;
	},
	ctx: PhaseContext
): Promise<readonly ResultRow[]> {
	const { client, token } = dependencies;

	if (retention.kind === 'root') {
		const { name, body } = retention.request;
		const summary = await client.setRoot(token, name, body);
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
		summaries.push(await client.setRoot(token, name, body));
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

function describePinExpiry(summaries: readonly RootSummary[]): string {
	const expiries = summaries
		.map((summary) => summary.expiresAt)
		.filter((expiresAt) => expiresAt !== undefined)
		.toSorted();
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
	readonly token: AccessCredential;
}

async function prepareUploads(
	decisions: readonly Extract<UploadDecision, { action: 'upload' }>[],
	closure: readonly NixValidPathInfo[],
	dependencies: PrepareUploadsDependencies
): Promise<readonly PreparedUpload[]> {
	const uploads: PreparedUpload[] = [];

	for (const decision of decisions) {
		const pathInfo = findNegotiatedPath(closure, decision);
		const preparedPath = await preparePushPath(pathInfo, dependencies);
		const upload = await dependencies.client.prepareUpload(
			dependencies.token,
			decision.uploadId,
			{
				fileHash: preparedPath.blob.fileHash.toString(),
				fileSize: preparedPath.blob.fileSize,
				compression: preparedPath.blob.compression
			}
		);

		uploads.push({
			decision,
			preparedPath,
			uploadUrl: upload.uploadUrl,
			uploadHeaders: upload.uploadHeaders
		});
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

function needsUpload(
	decision: UploadDecision
): decision is Extract<UploadDecision, { action: 'upload' }> {
	return decision.action === 'upload';
}

function needsCommit(
	decision: UploadDecision
): decision is Extract<UploadDecision, { action: 'commit' | 'upload' }> {
	return decision.action !== 'skip';
}

function needsReusedBlobCommit(
	decision: UploadDecision
): decision is Extract<UploadDecision, { action: 'commit' }> {
	return decision.action === 'commit';
}

function needsAttestationUpload(
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
): { readonly subjectDigests: readonly string[] } {
	let json: unknown;

	try {
		json = JSON.parse(new TextDecoder().decode(bytes));
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

function narHashDigestHex(hash: NixValidPathInfo['narHash']): string {
	return [...hash.digestBytes()]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

// Polls the deferred uploads until each reports `servable`, backing off between
// rounds. A `mismatch`, `over-quota` or `absent` verdict fails fast rather than
// hanging on a blob that will never become servable; exceeding the deadline times
// out. Shares the server's serve predicate via the status query.
async function waitForUploads(
	client: PushClient,
	token: AccessCredential,
	uploadIds: readonly string[],
	ctx: PhaseContext,
	options: WaitOptions
): Promise<void> {
	const pending = new Set(uploadIds);
	const deadline = options.now() + options.timeoutSeconds * 1000;

	while (pending.size > 0) {
		for (const uploadId of pending) {
			const { status } = await client.uploadStatus(token, uploadId);

			if (status === 'servable') {
				pending.delete(uploadId);
				continue;
			}

			if (status !== 'pending') {
				throw new UploadVerificationFailedError(uploadId, status);
			}
		}

		ctx.fact('pending', formatCount(pending.size));

		if (pending.size === 0) {
			return;
		}

		if (options.now() >= deadline) {
			throw new UploadWaitTimeoutError(pending.size, options.timeoutSeconds);
		}

		await options.sleep(options.intervalMs);
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
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
