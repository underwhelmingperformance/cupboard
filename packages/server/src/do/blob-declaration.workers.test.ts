import {
	type CommitBatchEntry,
	type CommitBlobDeclaration,
	type CommitSessionFrame
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pendingUploads } from '../db/schema.ts';
import { maxVerificationRpcRows } from '../http/http.ts';
import {
	currentServer,
	expectSingleUploadDecision,
	initialise,
	negotiateUploads,
	nixSha256Hash,
	openCommitSession,
	putNarBytes,
	resetTestServer,
	testBase,
	type VerifiableNar,
	verifiablePath
} from '../test-support.ts';

interface NegotiatedUpload {
	readonly token: string;
	readonly nar: VerifiableNar;
	readonly entry: CommitBatchEntry;
	readonly r2Key: string;
}

async function stagedUpload(seed: string): Promise<NegotiatedUpload> {
	const token = await initialise();
	const { metadata, nar } = await verifiablePath(seed, {
		storePathHash: 'a'.repeat(32),
		name: seed
	});
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);
	await putNarBytes(upload.r2Key, nar);

	return {
		token,
		nar,
		r2Key: upload.r2Key,
		entry: {
			uploadId: upload.uploadId,
			storePathHash: metadata.storePathHash,
			narHash: metadata.narHash
		}
	};
}

function declarationOf(nar: VerifiableNar): CommitBlobDeclaration {
	return { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength };
}

async function commitEntry(
	token: string,
	entry: CommitBatchEntry
): Promise<CommitSessionFrame> {
	const session = await openCommitSession(token);

	try {
		session.send({ op: 'commit-batch', commits: [entry] });

		return await session.nextFrame();
	} finally {
		session.socket.close();
	}
}

// Error frames are compared without their message text.
function frameFacts(frame: CommitSessionFrame): object {
	if (frame.ev !== 'error') {
		return frame;
	}

	return { ev: frame.ev, uploadId: frame.uploadId, status: frame.status };
}

async function storedDeclaration(
	uploadId: CommitBatchEntry['uploadId']
): Promise<{ readonly fileHash?: string; readonly fileSize?: number }> {
	const row = await runInDurableObject(currentServer(), (_instance, state) =>
		drizzle(state.storage, { schema: { pendingUploads } })
			.select({
				fileHash: pendingUploads.declaredFileHash,
				fileSize: pendingUploads.declaredFileSize
			})
			.from(pendingUploads)
			.where(eq(pendingUploads.id, uploadId))
			.get()
	);

	const fileHash = row?.fileHash ?? undefined;
	const fileSize = row?.fileSize ?? undefined;

	return {
		...(fileHash !== undefined && { fileHash }),
		...(fileSize !== undefined && { fileSize })
	};
}

describe('blob declarations on commit', () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(testBase);
		await resetTestServer();
	});

	it('stores the declaration and includes it in the verification claim', async () => {
		const { token, nar, entry, r2Key } = await stagedUpload('declared');
		const blob = declarationOf(nar);

		const frame = await commitEntry(token, { ...entry, blob });
		const claim = await currentServer().claimVerificationBatch(
			maxVerificationRpcRows,
			Number.MAX_SAFE_INTEGER
		);

		expect({
			frame,
			stored: await storedDeclaration(entry.uploadId),
			claims: claim.claims
		}).toStrictEqual({
			frame: {
				ev: 'deferred',
				uploadId: entry.uploadId,
				storePathHash: entry.storePathHash,
				narHash: entry.narHash
			},
			stored: blob,
			claims: [
				{
					uploadId: entry.uploadId,
					storePathHash: entry.storePathHash,
					r2Key,
					narHash: entry.narHash,
					narSize: nar.narSize,
					reuse: false,
					blob
				}
			]
		});
	});

	it('omits the declaration from the claim of an upload committed without one', async () => {
		const { token, nar, entry, r2Key } = await stagedUpload('undeclared');

		await commitEntry(token, entry);
		const claim = await currentServer().claimVerificationBatch(
			maxVerificationRpcRows,
			Number.MAX_SAFE_INTEGER
		);

		expect({
			stored: await storedDeclaration(entry.uploadId),
			claims: claim.claims
		}).toStrictEqual({
			stored: {},
			claims: [
				{
					uploadId: entry.uploadId,
					storePathHash: entry.storePathHash,
					r2Key,
					narHash: entry.narHash,
					narSize: nar.narSize,
					reuse: false
				}
			]
		});
	});

	it('accepts the same declaration again', async () => {
		const { token, nar, entry } = await stagedUpload('redeclared');
		const blob = declarationOf(nar);

		await commitEntry(token, { ...entry, blob });
		const repeated = await commitEntry(token, { ...entry, blob });

		expect({
			repeated,
			stored: await storedDeclaration(entry.uploadId)
		}).toStrictEqual({
			repeated: {
				ev: 'deferred',
				uploadId: entry.uploadId,
				storePathHash: entry.storePathHash,
				narHash: entry.narHash
			},
			stored: blob
		});
	});

	it.each([
		{ field: 'file size', change: { fileSize: 1 } },
		{ field: 'file hash', change: { fileHash: nixSha256Hash('1') } }
	])(
		'refuses a declaration with a different $field and keeps the first',
		async ({ change }) => {
			const { token, nar, entry } = await stagedUpload('conflicting');
			const blob = declarationOf(nar);

			await commitEntry(token, { ...entry, blob });
			const conflicting = await commitEntry(token, {
				...entry,
				blob: { ...blob, ...change }
			});

			expect({
				conflicting: frameFacts(conflicting),
				stored: await storedDeclaration(entry.uploadId)
			}).toStrictEqual({
				conflicting: {
					ev: 'error',
					uploadId: entry.uploadId,
					status: StatusCodes.CONFLICT
				},
				stored: blob
			});
		}
	);
});
