import path from 'node:path';

import { StorePath } from '@cupboard/nix/store-path';
import {
	type UploadPathMetadataFields,
	type UploadPathNegotiationFields
} from '@cupboard/protocol/upload';

import { readFileByteStream } from '../../packages/cli/src/io/file-stream.ts';
import { compressAndHashNarToFile } from '../../packages/cli/src/nix/blob.ts';
import { NarArchive } from '../../packages/cli/src/nix/nar.ts';
import type { PushClient } from '../../packages/cli/src/push/push.ts';

import { NixStore } from './nix.ts';

export interface PushContext {
	readonly client: PushClient;
	readonly store: NixStore;
	readonly workDirectory: string;
}

interface PreparedPath {
	readonly metadata: UploadPathMetadataFields;
	readonly compressedPath: string;
}

/**
 * Pushes the given store paths to a cupboard through the full client flow:
 * negotiate, then for each path either prepare-upload-and-commit (PUT to the
 * presigned URL) or commit a reused blob. Returns the metadata sent for each
 * path, keyed by store path hash.
 */
export async function pushStorePaths(
	context: PushContext,
	storePaths: readonly string[]
): Promise<ReadonlyMap<string, UploadPathMetadataFields>> {
	const prepared = await Promise.all(
		storePaths.map((storePath) => preparePath(context, storePath))
	);
	const byStorePathHash = new Map(
		prepared.map((entry) => [entry.metadata.storePathHash, entry])
	);

	const { uploads } = await context.client.negotiate({
		paths: prepared.map((entry) => negotiationFields(entry.metadata))
	});

	for (const decision of uploads) {
		const entry = byStorePathHash.get(decision.storePathHash);

		if (entry === undefined) {
			throw new UnexpectedUploadDecisionError(decision.storePathHash);
		}

		if (decision.action === 'upload') {
			const prepared = await context.client.prepareUpload(decision.uploadId, {
				fileHash: entry.metadata.fileHash,
				fileSize: entry.metadata.fileSize,
				compression: entry.metadata.compression
			});

			await context.client.uploadBlob({
				r2Key: decision.r2Key,
				uploadUrl: prepared.uploadUrl,
				headers: prepared.uploadHeaders,
				body: readFileByteStream(entry.compressedPath),
				contentLength: entry.metadata.fileSize
			});
		}

		if (decision.action !== 'skip') {
			await context.client.commit(decision.uploadId, {});
		}
	}

	return new Map(
		prepared.map((entry) => [entry.metadata.storePathHash, entry.metadata])
	);
}

function negotiationFields(
	metadata: UploadPathMetadataFields
): UploadPathNegotiationFields {
	return {
		storePathHash: metadata.storePathHash,
		storePath: metadata.storePath,
		narHash: metadata.narHash,
		narSize: metadata.narSize,
		references: metadata.references,
		deriver: metadata.deriver,
		ca: metadata.ca
	};
}

export interface NegotiatedUpload {
	readonly r2Key: string;
	readonly uploadUrl: string;
	readonly uploadHeaders: Readonly<Record<string, string>>;
	readonly compressedPath: string;
	readonly fileSize: number;
}

/**
 * Negotiates and prepares a single store path, returning the presigned upload
 * it yields. Lets a test drive the PUT itself, e.g. to assert that a tampered
 * upload is rejected.
 */
export async function negotiateUpload(
	context: PushContext,
	storePath: string
): Promise<NegotiatedUpload> {
	const entry = await preparePath(context, storePath);
	const { uploads } = await context.client.negotiate({
		paths: [negotiationFields(entry.metadata)]
	});
	const [decision] = uploads;

	if (decision?.action !== 'upload') {
		throw new UnexpectedUploadDecisionError(entry.metadata.storePathHash);
	}

	const prepared = await context.client.prepareUpload(decision.uploadId, {
		fileHash: entry.metadata.fileHash,
		fileSize: entry.metadata.fileSize,
		compression: entry.metadata.compression
	});

	return {
		r2Key: decision.r2Key,
		uploadUrl: prepared.uploadUrl,
		uploadHeaders: prepared.uploadHeaders,
		compressedPath: entry.compressedPath,
		fileSize: entry.metadata.fileSize
	};
}

async function preparePath(
	context: PushContext,
	storePath: string
): Promise<PreparedPath> {
	const info = await context.store.pathInfo(storePath);
	const compressedPath = path.join(
		context.workDirectory,
		`${StorePath.hash(storePath)}.nar.zst`
	);
	const { compressed, narDigest } = await compressAndHashNarToFile(
		new NarArchive(context.store.physicalPath(storePath)),
		compressedPath
	);

	return {
		compressedPath,
		metadata: {
			storePathHash: StorePath.hash(storePath),
			storePath,
			narHash: narDigest.narHash.toString(),
			narSize: narDigest.narSize,
			fileHash: compressed.blob.fileHash.toString(),
			fileSize: compressed.blob.fileSize,
			compression: 'zstd',
			references: StorePath.referenceBasenames(info.references),
			ca: info.ca
		}
	};
}

export class UnexpectedUploadDecisionError extends Error {
	constructor(public readonly storePathHash: string) {
		super(`Unexpected upload decision for store path hash: ${storePathHash}`);
		this.name = 'UnexpectedUploadDecisionError';
	}
}
