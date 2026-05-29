import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import pathModule from 'node:path';

import {
	type CommitResponse,
	StorePath,
	type UploadDecision,
	type UploadNegotiateRequest,
	type UploadNegotiateResponse,
	type UploadPrepareRequest,
	type UploadPrepareResponse
} from '@cupboard/shared';

import {
	compressAndHashNarToFile,
	type CompressedAndHashedNarFile,
	type CompressedNarBlob
} from './blob.ts';
import {
	PushNarMetadataMismatchError,
	UnexpectedUploadDecisionError
} from './errors.ts';
import { readFileByteStream } from './file-stream.ts';
import { NarArchive, type NarDigest } from './nar.ts';
import { NixDaemonStoreClient } from './nix-daemon.ts';
import {
	type NixStoreClient,
	type NixValidPathInfo,
	type PreparedStorePath,
	prepareStorePathMetadata,
	prepareStorePathNegotiation
} from './nix-store.ts';
import { formatBytes, formatCount, type Reporter } from './reporter.ts';

export interface PushDependencies {
	readonly nixStore?: NixStoreClient;
	readonly client: PushClient;
	readonly token: string;
	readonly createNarArchive?: (storePath: string) => PushNarArchive;
	readonly compressNar?: CompressNar;
	readonly readCompressedNar?: ReadCompressedNar;
	readonly createTemporaryDirectory?: () => Promise<string>;
	readonly removeTemporaryDirectory?: (path: string) => Promise<void>;
}

export interface PushClient {
	negotiate(
		token: string,
		body: UploadNegotiateRequest
	): Promise<UploadNegotiateResponse>;
	prepareUpload(
		token: string,
		uploadId: string,
		body: UploadPrepareRequest
	): Promise<UploadPrepareResponse>;
	uploadBlob(upload: PushBlobUpload): Promise<void>;
	commit(token: string, uploadId: string): Promise<CommitResponse>;
}

export type PushNarArchive =
	| ReadableStream<Uint8Array>
	| AsyncIterable<Uint8Array>;

export type CompressNar = (
	nar: PushNarArchive,
	path: string
) => Promise<CompressedAndHashedNarFile>;

export type ReadCompressedNar = (path: string) => ReadableStream<Uint8Array>;

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
			nixStore,
			createNarArchive,
			compressNar,
			readCompressedNar,
			temporaryDirectory
		});
	} finally {
		await removeTemporaryDirectory(temporaryDirectory);
	}
}

interface PushRuntimeDependencies {
	readonly nixStore: NixStoreClient;
	readonly client: PushClient;
	readonly token: string;
	readonly createNarArchive: (storePath: string) => PushNarArchive;
	readonly compressNar: CompressNar;
	readonly readCompressedNar: ReadCompressedNar;
	readonly temporaryDirectory: string;
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
		createNarArchive,
		compressNar,
		readCompressedNar
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

	await reporter.phase('Committing metadata', async (ctx) => {
		const decisions = negotiation.uploads.filter((decision) =>
			needsCommit(decision)
		);
		const responses: CommitResponse[] = [];

		for (const decision of decisions) {
			responses.push(await client.commit(token, decision.uploadId));
			ctx.fact('committed', formatCount(responses.length));
		}

		return responses;
	});
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
		{ label: 'Uploaded', value: formatBytes(uploadedBytes) }
	]);
}

interface PreparePushPathDependencies {
	readonly createNarArchive: (storePath: string) => PushNarArchive;
	readonly compressNar: CompressNar;
	readonly temporaryDirectory: string;
}

interface PrepareUploadsDependencies extends PreparePushPathDependencies {
	readonly client: PushClient;
	readonly token: string;
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

function defaultCreateTemporaryDirectory(): Promise<string> {
	return mkdtemp(pathModule.join(tmpdir(), 'cupboard-push-'));
}

function defaultRemoveTemporaryDirectory(path: string): Promise<void> {
	return rm(path, { force: true, recursive: true });
}
