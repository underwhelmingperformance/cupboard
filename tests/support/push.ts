import { StorePath } from '@cupboard/nix-store/store-path';
import {
	uploadActionDecisionSchema,
	uploadDecisionSchema,
	type UploadPathNegotiationFields
} from '@cupboard/protocol/upload';
import { expect } from 'vitest';

import { compressNarToStream } from '../../packages/cli/src/nix/blob.ts';
import { NarArchive } from '../../packages/cli/src/nix/nar.ts';
import type { PushClient } from '../../packages/cli/src/push/push.ts';

import { NixStore } from './nix.ts';

export interface PushContext {
	readonly client: PushClient;
	readonly store: NixStore;
}

interface NegotiatedPath {
	readonly storePath: string;
	readonly fields: UploadPathNegotiationFields;
}

interface UploadIdentity {
	readonly storePathHash: string;
	readonly narHash: string;
}

/**
 * Pushes the given store paths to a cupboard through the full client flow:
 * negotiate, then for each path either stream its compressed NAR to the staging
 * key the server names and commit, or commit a reused blob. The server derives
 * the file hash and size from the streamed bytes, so the push carries only the
 * path metadata it can read from the store.
 */
export async function pushStorePaths(
	context: PushContext,
	storePaths: readonly string[]
): Promise<void> {
	const negotiations = await Promise.all(
		storePaths.map((storePath) => negotiationFor(context, storePath))
	);
	const { uploads } = await context.client.negotiate({
		paths: negotiations.map((entry) => entry.fields)
	});
	const decisions = uploads.map((decision) =>
		uploadDecisionSchema.parse(decision)
	);

	expect(
		decisions.map((decision) => uploadIdentity(decision)).toSorted(byIdentity)
	).toStrictEqual(
		negotiations
			.map((entry) => uploadIdentity(entry.fields))
			.toSorted(byIdentity)
	);

	for (const decision of decisions) {
		if (decision.action === 'upload') {
			await context.client.uploadNar(
				decision.r2Key,
				compressedNar(context, findNegotiation(negotiations, decision))
			);
		}

		if (decision.action !== 'skip') {
			await context.client.commit(
				{
					uploadId: decision.uploadId,
					storePathHash: decision.storePathHash,
					narHash: decision.narHash
				},
				{}
			);
		}
	}
}

export interface NegotiatedUpload {
	readonly uploadId: string;
	readonly r2Key: string;
	readonly storePathHash: string;
	readonly narHash: string;
	readonly compressed: Uint8Array;
}

/**
 * Negotiates a single store path and returns the upload it yields together with
 * the path's compressed NAR bytes. Lets a test drive the staging write itself,
 * e.g. to stage tampered bytes and assert verification rejects the commit.
 */
export async function negotiateUpload(
	context: PushContext,
	storePath: string
): Promise<NegotiatedUpload> {
	const entry = await negotiationFor(context, storePath);
	const { uploads } = await context.client.negotiate({ paths: [entry.fields] });
	const [only] = uploads;
	const decision = uploadActionDecisionSchema.parse(only);

	expect(uploadIdentity(decision)).toStrictEqual(uploadIdentity(entry.fields));

	return {
		uploadId: decision.uploadId,
		r2Key: decision.r2Key,
		storePathHash: decision.storePathHash,
		narHash: decision.narHash,
		compressed: await collectStream(compressedNar(context, entry))
	};
}

async function negotiationFor(
	context: PushContext,
	storePath: string
): Promise<NegotiatedPath> {
	const info = await context.store.pathInfo(storePath);

	return {
		storePath,
		fields: {
			storePathHash: StorePath.hash(storePath),
			storePath,
			narHash: info.narHash.toString(),
			narSize: info.narSize,
			references: StorePath.referenceBasenames(info.references),
			ca: info.ca
		}
	};
}

function compressedNar(
	context: PushContext,
	entry: NegotiatedPath
): ReadableStream<Uint8Array> {
	return compressNarToStream(
		new NarArchive(context.store.physicalPath(entry.storePath))
	).body;
}

async function collectStream(
	stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findNegotiation(
	negotiations: readonly NegotiatedPath[],
	decision: UploadIdentity
): NegotiatedPath {
	const entry = negotiations.find(
		(item) => identityKey(item.fields) === identityKey(decision)
	);

	if (entry === undefined) {
		throw new UnexpectedUploadDecisionError(
			decision.storePathHash,
			decision.narHash
		);
	}

	return entry;
}

function uploadIdentity(fields: UploadIdentity): UploadIdentity {
	return {
		storePathHash: fields.storePathHash,
		narHash: fields.narHash
	};
}

function identityKey(fields: UploadIdentity): string {
	return `${fields.storePathHash}\0${fields.narHash}`;
}

function byIdentity(left: UploadIdentity, right: UploadIdentity): number {
	return (
		left.storePathHash.localeCompare(right.storePathHash) ||
		left.narHash.localeCompare(right.narHash)
	);
}

class UnexpectedUploadDecisionError extends Error {
	constructor(
		public readonly storePathHash: string,
		public readonly narHash: string
	) {
		super(`No negotiated path for decision ${storePathHash}/${narHash}`);
		this.name = 'UnexpectedUploadDecisionError';
	}
}
