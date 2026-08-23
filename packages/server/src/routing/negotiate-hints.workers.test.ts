import { DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import {
	acceptCapabilitiesHeader,
	type ParsedUploadPathMetadata,
	uploadGraceFactsCapability,
	uploadNegotiateResponseSchema
} from '@cupboard/protocol/upload';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { negotiateHintsHeader } from '../do/negotiate-hints.ts';
import {
	armBlobReaperTimer,
	authorisedFetch,
	blobStateArmTimes,
	commitPath,
	CommitSocketError,
	commitUploadRejection,
	currentServer,
	deleteBlobReferenceEdge,
	expectSingleCommitDecision,
	expectSingleUploadDecision,
	flakyD1,
	handlerFetch,
	initialise,
	narInfoDeletionRows,
	narInfoGeneration,
	resetTestServer,
	seedCanonicalBlob,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	useTestServer,
	verifiableNar,
	verifiablePath
} from '../test-support.ts';

import { computeNegotiateHints } from './negotiate-hints.ts';
import { fixtureTenant } from './tenant-routing.test-support.ts';

function expectCommitSocketError(
	error: unknown
): asserts error is CommitSocketError {
	expect(error).toBeInstanceOf(CommitSocketError);
}

async function negotiateViaWorker(
	token: string,
	paths: readonly ParsedUploadPathMetadata[],
	extraHeaders: Record<string, string> = {}
) {
	const response = await handlerFetch(
		`/t/${fixtureTenant}/cache/_default/uploads`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
				...extraHeaders
			},
			body: JSON.stringify({
				pushId: testPushId,
				paths: paths.map((path) => uploadPathNegotiation(path))
			})
		}
	);

	expect(response.status).toBe(StatusCodes.OK);

	return uploadNegotiateResponseSchema.parse(await response.json());
}

function actionsByPath(response: {
	uploads: readonly { action: string; storePathHash: string }[];
}): Record<string, string> {
	return Object.fromEntries(
		response.uploads.map((upload) => [upload.storePathHash, upload.action])
	);
}

function probeRequest(
	body: unknown,
	headers?: Record<string, string>
): Request {
	return new Request(
		`https://cache.example/t/${fixtureTenant}/cache/_default/uploads`,
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(headers ?? { authorization: 'Bearer junk' })
			},
			body: typeof body === 'string' ? body : JSON.stringify(body)
		}
	);
}

// Hint computation runs before the Durable Object authenticates the request.
// The signed push ID and path cap bound the D1 reads available at this stage.
describe('computing negotiate hints', () => {
	const path = uploadPathNegotiation(uploadMetadata({ fileSize: 1 }));

	it('computes hints only for a signed push id', async () => {
		const signed = await computeNegotiateHints(
			probeRequest({ pushId: testPushId, paths: [path] }),
			env,
			fixtureTenant,
			DEFAULT_CACHE
		);
		const forged = await computeNegotiateHints(
			probeRequest({ pushId: 'a'.repeat(96), paths: [path] }),
			env,
			fixtureTenant,
			DEFAULT_CACHE
		);

		expect({ signed, forged }).toStrictEqual({
			signed: { blobStates: [], ownedNarHashes: [], committedEdges: [] },
			forged: undefined
		});
	});

	it('tolerates the grace-facts capability header', async () => {
		const hints = await computeNegotiateHints(
			probeRequest(
				{ pushId: testPushId, paths: [path] },
				{
					authorization: 'Bearer junk',
					[acceptCapabilitiesHeader]: uploadGraceFactsCapability
				}
			),
			env,
			fixtureTenant,
			DEFAULT_CACHE
		);

		expect(hints).toStrictEqual({
			blobStates: [],
			ownedNarHashes: [],
			committedEdges: []
		});
	});

	it('returns no hints without a bearer header', async () => {
		const hints = await computeNegotiateHints(
			probeRequest({ pushId: testPushId, paths: [path] }, {}),
			env,
			fixtureTenant,
			DEFAULT_CACHE
		);

		expect(hints).toBeUndefined();
	});

	it('returns no hints for an unparseable body', async () => {
		const hints = await computeNegotiateHints(
			probeRequest('{not json'),
			env,
			fixtureTenant,
			DEFAULT_CACHE
		);

		expect(hints).toBeUndefined();
	});

	it('returns no hints past the path cap', async () => {
		const paths = Array.from({ length: 10_001 }, () => path);
		const hints = await computeNegotiateHints(
			probeRequest({ pushId: testPushId, paths }),
			env,
			fixtureTenant,
			DEFAULT_CACHE
		);

		expect(hints).toBeUndefined();
	});

	it('returns no hints when the shared-fact reads fail', async () => {
		const faultyEnv = {
			...env,
			CUPBOARD_DB: flakyD1(env.CUPBOARD_DB, {
				failures: Number.MAX_SAFE_INTEGER
			})
		};
		const hints = await computeNegotiateHints(
			probeRequest({ pushId: testPushId, paths: [path] }),
			faultyEnv,
			fixtureTenant,
			DEFAULT_CACHE
		);

		expect(hints).toBeUndefined();
	});
});

describe('negotiate hints', () => {
	beforeEach(async () => {
		await resetTestServer();
		await useTestServer(fixtureTenant);
	});

	it('decides a mixed closure identically with and without hints', async () => {
		const token = await initialise();
		const committedNar = await verifiableNar('hints-committed');
		const committed = uploadMetadata({
			name: 'committed',
			storePathHash: '1'.repeat(32),
			narHash: committedNar.narHash,
			fileHash: committedNar.fileHash,
			fileSize: committedNar.narBytes.byteLength,
			narSize: committedNar.narSize
		});

		await commitPath(token, committed, committedNar);

		const reuse = uploadMetadata({
			name: 'reuse',
			storePathHash: '2'.repeat(32),
			narHash: committedNar.narHash,
			fileHash: committedNar.fileHash,
			fileSize: committedNar.narBytes.byteLength,
			narSize: committedNar.narSize
		});
		const { metadata: fresh } = await verifiablePath('hints-fresh', {
			storePathHash: '3'.repeat(32),
			name: 'fresh'
		});
		const paths = [committed, reuse, fresh];

		const hinted = await negotiateViaWorker(token, paths);
		const direct = await authorisedFetch('/cache/_default/uploads', token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				pushId: testPushId,
				paths: paths.map((path) => uploadPathNegotiation(path))
			})
		});

		expect(direct.status).toBe(StatusCodes.OK);

		const directDecisions = uploadNegotiateResponseSchema.parse(
			await direct.json()
		);

		expect({
			hinted: actionsByPath(hinted),
			direct: actionsByPath(directDecisions)
		}).toStrictEqual({
			hinted: {
				[committed.storePathHash]: 'skip',
				[reuse.storePathHash]: 'commit',
				[fresh.storePathHash]: 'upload'
			},
			direct: {
				[committed.storePathHash]: 'skip',
				[reuse.storePathHash]: 'commit',
				[fresh.storePathHash]: 'upload'
			}
		});
	});

	it('keeps a committed path skippable when its NAR was rebuilt', async () => {
		const token = await initialise();
		const nar = await verifiableNar('hints-rebuilt');
		const committed = uploadMetadata({
			name: 'rebuilt',
			storePathHash: '9'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, committed, nar);

		const generation = await narInfoGeneration(committed.storePathHash);

		// The hints cover only the new NAR hash. The Durable Object must still read
		// the old committed hash before deciding whether the path can skip.
		const rebuiltNar = await verifiableNar('hints-rebuilt-other');
		const rebuilt = uploadMetadata({
			name: 'rebuilt',
			storePathHash: committed.storePathHash,
			narHash: rebuiltNar.narHash,
			fileHash: rebuiltNar.fileHash,
			fileSize: rebuiltNar.narBytes.byteLength,
			narSize: rebuiltNar.narSize
		});
		const hinted = await negotiateViaWorker(token, [rebuilt]);

		expect({
			decisions: actionsByPath(hinted),
			generation: await narInfoGeneration(committed.storePathHash),
			queued: await narInfoDeletionRows()
		}).toStrictEqual({
			decisions: { [committed.storePathHash]: 'skip' },
			generation,
			queued: []
		});
	});

	it('fails a hinted edge check towards not-committed', async () => {
		const token = await initialise();
		const nar = await verifiableNar('hints-edge');
		const committed = uploadMetadata({
			name: 'edge',
			storePathHash: '8'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, committed, nar);

		// Leave a narinfo row without its committed edge.
		const generation = await narInfoGeneration(committed.storePathHash);

		expect(generation).toBeDefined();

		if (generation !== undefined) {
			await deleteBlobReferenceEdge(committed.storePathHash, generation);
		}

		const hinted = await negotiateViaWorker(token, [committed]);

		expect(actionsByPath(hinted)).toStrictEqual({
			[committed.storePathHash]: 'commit'
		});
	});

	it('ignores a client-supplied hint token', async () => {
		const token = await initialise();
		const { metadata } = await verifiablePath('hints-forged-token', {
			storePathHash: '4'.repeat(32),
			name: 'forged'
		});

		const response = await negotiateViaWorker(token, [metadata], {
			[negotiateHintsHeader]: crypto.randomUUID()
		});

		expectSingleUploadDecision(response, metadata);
	});

	it('never lets stale hints publish bytes the tenant does not hold', async () => {
		const token = await initialise();
		const nar = await verifiableNar('hints-unowned');
		const metadata = uploadMetadata({
			name: 'unowned',
			storePathHash: '5'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		// A global blob without this tenant's ownership row must not be reusable.
		await seedCanonicalBlob(nar);

		// Stage stale facts that claim ownership the tenant does not have.
		const staged = await currentServer().stageNegotiateHints({
			blobStates: [
				{
					narHash: nar.narHash,
					fileHash: nar.fileHash,
					fileSize: nar.narBytes.byteLength,
					compression: 'zstd',
					narSize: nar.narSize,
					deleteAfter: new Date(Date.now() + 60_000).toISOString()
				}
			],
			ownedNarHashes: [nar.narHash]
		});
		const hintedResponse = await authorisedFetch(
			'/cache/_default/uploads',
			token,
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					[negotiateHintsHeader]: staged
				},
				body: JSON.stringify({
					pushId: testPushId,
					paths: [uploadPathNegotiation(metadata)]
				})
			}
		);

		expect(hintedResponse.status).toBe(StatusCodes.OK);

		const decision = expectSingleCommitDecision(
			uploadNegotiateResponseSchema.parse(await hintedResponse.json()),
			metadata
		);

		const commitError = await commitUploadRejection(token, decision.uploadId);

		expectCommitSocketError(commitError);
		expect({ status: commitError.status }).toStrictEqual({
			status: StatusCodes.NOT_FOUND
		});

		const replayed = await authorisedFetch('/cache/_default/uploads', token, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				[negotiateHintsHeader]: staged
			},
			body: JSON.stringify({
				pushId: testPushId,
				paths: [uploadPathNegotiation(metadata)]
			})
		});

		expect(replayed.status).toBe(StatusCodes.OK);
		expectSingleUploadDecision(
			uploadNegotiateResponseSchema.parse(await replayed.json()),
			metadata
		);
	});

	it('clears the reaper timer for a hinted reuse before answering', async () => {
		const token = await initialise();
		const nar = await verifiableNar('hints-timer');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: '6'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);
		await armBlobReaperTimer(nar.narHash);

		const reuse = uploadMetadata({
			name: 'reuse',
			storePathHash: '7'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const response = await negotiateViaWorker(token, [reuse]);

		expectSingleCommitDecision(response, reuse);

		expect(await blobStateArmTimes()).toStrictEqual([
			{ narHash: nar.narHash, deleteAfter: undefined }
		]);
	});
});
