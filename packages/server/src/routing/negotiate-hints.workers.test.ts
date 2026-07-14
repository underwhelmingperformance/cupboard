import {
	type ParsedUploadPathMetadata,
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

// The hint computation runs in the front Worker before the Durable Object
// authenticates the bearer, so its D1 reads are gated on the body's signed
// push id and bounded by the path cap; anything unexpected computes nothing
// and the request dispatches plainly.
describe('computing negotiate hints', () => {
	const path = uploadPathNegotiation(uploadMetadata({ fileSize: 1 }));

	it('computes hints only for a signed push id', async () => {
		const signed = await computeNegotiateHints(
			probeRequest({ pushId: testPushId, paths: [path] }),
			env,
			fixtureTenant,
			'_default'
		);
		const forged = await computeNegotiateHints(
			probeRequest({ pushId: 'a'.repeat(96), paths: [path] }),
			env,
			fixtureTenant,
			'_default'
		);

		expect({ signed, forged }).toStrictEqual({
			signed: { blobStates: [], ownedNarHashes: [], committedEdges: [] },
			forged: undefined
		});
	});

	it('tolerates a retention plan in the negotiate body', async () => {
		const hints = await computeNegotiateHints(
			probeRequest({
				pushId: testPushId,
				paths: [path],
				retention: { kind: 'none' }
			}),
			env,
			fixtureTenant,
			'_default'
		);

		expect(hints).toStrictEqual({
			blobStates: [],
			ownedNarHashes: [],
			committedEdges: []
		});
	});

	it('computes none without a bearer header', async () => {
		const hints = await computeNegotiateHints(
			probeRequest({ pushId: testPushId, paths: [path] }, {}),
			env,
			fixtureTenant,
			'_default'
		);

		expect(hints).toBeUndefined();
	});

	it('computes none for an unparseable body', async () => {
		const hints = await computeNegotiateHints(
			probeRequest('{not json'),
			env,
			fixtureTenant,
			'_default'
		);

		expect(hints).toBeUndefined();
	});

	it('computes none past the path cap', async () => {
		const paths = Array.from({ length: 10_001 }, () => path);
		const hints = await computeNegotiateHints(
			probeRequest({ pushId: testPushId, paths }),
			env,
			fixtureTenant,
			'_default'
		);

		expect(hints).toBeUndefined();
	});

	it('computes none when the shared-fact reads fault', async () => {
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
			'_default'
		);

		expect(hints).toBeUndefined();
	});
});

describe('negotiate hints', () => {
	// Worker-routed requests reach the shared fixture tenant's Durable Object,
	// so the harness targets that same object for the direct half of each test.
	// Its durable SQLite persists across the file, hence the per-test store
	// path hashes.
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

		// A second path over the committed blob (a reuse) and a wholly fresh one.
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

		// Through the Worker the decisions come from staged hints; directly
		// against the Durable Object they come from its own D1 reads.
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

		// The same store path rebuilt non-reproducibly: a different NAR behind
		// the same path. The Worker's hint reads cover only the pushed hash, so
		// the committed row's own NAR sits outside them; its presence must still
		// be read; its presence is not presumed lost, or the live row would be reconciled
		// away and the path re-planned as an upload.
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

		// The row survives but its committed edge is gone, the residue of a
		// delete that crashed between the edge retirement and the row.
		const generation = await narInfoGeneration(committed.storePathHash);

		expect(generation).toBeDefined();

		if (generation !== undefined) {
			await deleteBlobReferenceEdge(committed.storePathHash, generation);
		}

		// No edge means no skip: the hinted check fails towards not-committed
		// and the path re-plans, as a reuse commit since the tenant still holds
		// the blob.
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

		// The shared blob exists (another tenant's, say) but this tenant holds no
		// presence edge for it.
		await seedCanonicalBlob(nar);

		// Hints claiming ownership regardless: negotiate believes its plan and
		// offers the reuse, exactly what a stale (or hostile) hint set would do.
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

		// The commit re-checks ownership and refuses: the plan was advisory, and
		// the existence oracle holds against the hint.
		const commitError = await commitUploadRejection(token, decision.uploadId);

		expectCommitSocketError(commitError);
		expect({ status: commitError.status }).toStrictEqual({
			status: StatusCodes.NOT_FOUND
		});

		// The token was consumed by the first negotiate; replaying it falls back
		// to the object's own facts, which offer an upload.
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
