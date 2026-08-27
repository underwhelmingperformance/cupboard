import {
	DEFAULT_CACHE,
	DEFAULT_CACHE_SELECTOR,
	rootNameSchema
} from '@cupboard/nix-store/scalars';
import {
	type UploadAttachRoot,
	type UploadNegotiateResponse,
	uploadNegotiateResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	authorisedFetch,
	commitUpload,
	currentServer,
	initialise,
	narBytes,
	putNarBytes,
	resetTestServer,
	runGcResult,
	setRoot,
	singleDecision,
	testBase,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation,
	verifyCurrentTenant
} from '../test-support.ts';

type PendingRow = typeof schema.pendingUploads.$inferSelect;

const runRoot: UploadAttachRoot = { name: 'ci/run-1', ttlSeconds: 3600 };

async function negotiateWithRoot(
	token: string,
	paths: readonly ReturnType<typeof uploadMetadata>[],
	attachRoot?: UploadAttachRoot
): Promise<UploadNegotiateResponse> {
	const response = await authorisedFetch(
		`/cache/${DEFAULT_CACHE_SELECTOR}/uploads`,
		token,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				pushId: testPushId,
				paths: paths.map((path) => uploadPathNegotiation(path)),
				...(attachRoot !== undefined && { attachRoot })
			})
		}
	);

	expect(response.status).toBe(StatusCodes.OK);

	return uploadNegotiateResponseSchema.parse(await response.json());
}

async function pushWithRoot(
	token: string,
	metadata: ReturnType<typeof uploadMetadata>,
	attachRoot?: UploadAttachRoot
): Promise<void> {
	const decision = singleDecision(
		await negotiateWithRoot(token, [metadata], attachRoot)
	);

	if (decision.action === 'skip') {
		return;
	}

	if (decision.action === 'upload') {
		await putNarBytes(decision.r2Key);
	}

	await commitUpload(token, decision.uploadId);
}

async function rootTargetRows(): Promise<readonly unknown[]> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select()
			.from(schema.retentionRootTargets)
			.all()
			.toSorted((left, right) =>
				`${left.rootName} ${left.storePathHash}`.localeCompare(
					`${right.rootName} ${right.storePathHash}`
				)
			)
	);
}

async function retentionState(): Promise<{
	roots: readonly unknown[];
	grace: readonly unknown[];
	caches: readonly unknown[];
}> {
	return runInDurableObject(currentServer(), (instance) => ({
		roots: instance.context.db
			.select()
			.from(schema.retentionRoots)
			.all()
			.map((row) => ({ ...row, expiresAt: row.expiresAt ?? undefined })),
		grace: instance.context.db.select().from(schema.retentionGrace).all(),
		caches: instance.context.db
			.select({
				name: schema.caches.name,
				graceManaged: schema.caches.graceManaged
			})
			.from(schema.caches)
			.all()
	}));
}

async function pendingRowSnapshot(uploadId: string): Promise<PendingRow> {
	const row = await runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select()
			.from(schema.pendingUploads)
			.all()
			.find((candidate) => candidate.id === uploadId)
	);

	if (row === undefined) {
		throw new Error(`no pending row for ${uploadId}`);
	}

	return row;
}

// Re-plants a cleared pending row as still awaiting its verdict, the state an
// eviction leaves when the settle applied but the clear-marker step never ran.
async function replantStuckPending(row: PendingRow): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.insert(schema.pendingUploads)
			.values({ ...row, verdict: 'pending', claimedAt: undefined })
			.run();
	});
}

describe('root attach at commit', () => {
	beforeEach(resetTestServer);

	it('attaches every materialised path to the bound run root', async () => {
		const token = await initialise();
		// The first path uploads the blob and settles through the deferred
		// verification flush; the second negotiates a reuse commit of the
		// now-canonical bytes and settles through the inline flush.
		const fresh = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'fresh',
			storePathHash: 'a'.repeat(32)
		});
		const reuse = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'reuse',
			storePathHash: 'b'.repeat(32)
		});

		await pushWithRoot(token, fresh, runRoot);
		await pushWithRoot(token, reuse, runRoot);

		expect(await rootTargetRows()).toStrictEqual([
			{
				cache: '',
				rootName: runRoot.name,
				storePathHash: fresh.storePathHash,
				storePath: fresh.storePath
			},
			{
				cache: '',
				rootName: runRoot.name,
				storePathHash: reuse.storePathHash,
				storePath: reuse.storePath
			}
		]);
	});

	it('attach touches neither the root expiry nor the grace state', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32)
		});

		await pushWithRoot(token, metadata, runRoot);

		expect(await retentionState()).toStrictEqual({
			roots: [
				{
					cache: '',
					name: runRoot.name,
					expiresAt: '2026-01-01T01:00:00.000Z',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z'
				}
			],
			grace: [],
			caches: [{ name: '', graceManaged: false }]
		});
	});

	it('a partially applied attach replays as exactly one row', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32)
		});

		// The state an interrupted earlier flush leaves: the target row already
		// applied while the settle that wrote it never finished.
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.retentionRootTargets)
				.values({
					cache: DEFAULT_CACHE,
					rootName: rootNameSchema.parse(runRoot.name),
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath
				})
				.run();
		});

		await pushWithRoot(token, metadata, runRoot);

		expect(await rootTargetRows()).toStrictEqual([
			{
				cache: '',
				rootName: runRoot.name,
				storePathHash: metadata.storePathHash,
				storePath: metadata.storePath
			}
		]);
	});

	it('re-driving a settled commit attaches exactly once', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32)
		});
		const decision = singleDecision(
			await negotiateWithRoot(token, [metadata], runRoot)
		);

		if (decision.action !== 'upload') {
			throw new Error('expected an upload decision');
		}

		await putNarBytes(decision.r2Key);
		const planted = await pendingRowSnapshot(decision.uploadId);
		await commitUpload(token, decision.uploadId);

		const afterSettle = await rootTargetRows();

		// The settle applied but the clear-marker step never ran: the verify
		// pass re-drives the same commit and must attach nothing new.
		await replantStuckPending(planted);
		await verifyCurrentTenant();

		const expected = [
			{
				cache: '',
				rootName: runRoot.name,
				storePathHash: metadata.storePathHash,
				storePath: metadata.storePath
			}
		];

		expect({
			afterSettle,
			afterRedrive: await rootTargetRows()
		}).toStrictEqual({ afterSettle: expected, afterRedrive: expected });
	});

	it("a losing push's root still gains the winner's path", async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32)
		});

		// Both pushes negotiate the same path before either commits, each bound
		// to its own run root; the first to commit wins the path.
		const winner = singleDecision(
			await negotiateWithRoot(token, [metadata], runRoot)
		);
		const loser = singleDecision(
			await negotiateWithRoot(token, [metadata], {
				name: 'ci/run-2',
				ttlSeconds: 3600
			})
		);

		if (winner.action !== 'upload' || loser.action !== 'upload') {
			throw new Error('expected two upload decisions');
		}

		await putNarBytes(winner.r2Key);
		await commitUpload(token, winner.uploadId);

		await putNarBytes(loser.r2Key);
		const conceded = await commitUpload(token, loser.uploadId);

		expect({
			conceded,
			targets: await rootTargetRows()
		}).toStrictEqual({
			conceded: {
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'already-present'
			},
			targets: [
				{
					cache: '',
					rootName: runRoot.name,
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath
				},
				{
					cache: '',
					rootName: 'ci/run-2',
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath
				}
			]
		});
	});

	it('a skip returned by negotiation attaches to the bound run root', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32)
		});

		// The path is canonical before the run root's push negotiates it: the
		// answer is a skip, whose publication settles at negotiate with no
		// commit to attach through.
		await pushWithRoot(token, metadata);

		const first = singleDecision(
			await negotiateWithRoot(token, [metadata], runRoot)
		);
		const afterFirst = await rootTargetRows();

		// Re-negotiating the served path under the same root re-inserts nothing.
		const second = singleDecision(
			await negotiateWithRoot(token, [metadata], runRoot)
		);

		const expected = [
			{
				cache: '',
				rootName: runRoot.name,
				storePathHash: metadata.storePathHash,
				storePath: metadata.storePath
			}
		];

		expect({
			firstAction: first.action,
			secondAction: second.action,
			afterFirst,
			afterSecond: await rootTargetRows(),
			retention: await retentionState()
		}).toStrictEqual({
			firstAction: 'skip',
			secondAction: 'skip',
			afterFirst: expected,
			afterSecond: expected,
			retention: {
				roots: [
					{
						cache: '',
						name: runRoot.name,
						expiresAt: '2026-01-01T01:00:00.000Z',
						createdAt: '2026-01-01T00:00:00.000Z',
						updatedAt: '2026-01-01T00:00:00.000Z'
					}
				],
				grace: [],
				caches: [{ name: '', graceManaged: false }]
			}
		});
	});

	it('a row from a rootless negotiate commits without attaching', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32)
		});

		await pushWithRoot(token, metadata);

		expect(await rootTargetRows()).toStrictEqual([]);
	});

	it('an attached path survives collection until the run root expires', async () => {
		const token = await initialise();
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'kept',
			storePathHash: 'a'.repeat(32)
		});
		const attached = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'attached',
			storePathHash: 'b'.repeat(32)
		});

		await pushWithRoot(token, kept);
		await setRoot(token, { name: 'main', targets: [kept.storePath] });
		await pushWithRoot(token, attached, runRoot);

		const whileLive = await runGcResult();

		// After the run root expires, only the permanently rooted path still has a
		// retention target.
		vi.setSystemTime(new Date(testBase.getTime() + 2 * 3600 * 1000));
		const afterExpiry = await runGcResult();

		const narInfoHashes = await runInDurableObject(
			currentServer(),
			(instance) =>
				instance.context.db
					.select({ storePathHash: schema.narInfos.storePathHash })
					.from(schema.narInfos)
					.all()
					.map((row) => row.storePathHash)
		);

		expect({
			whileLive,
			afterExpiry,
			targets: await rootTargetRows(),
			narInfoHashes
		}).toStrictEqual({
			whileLive: {
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsCollected: 0,
				narInfosDeleted: 0,
				orphanStagingDeleted: 0
			},
			afterExpiry: {
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 1,
				pathsCollected: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			},
			targets: [
				{
					cache: '',
					rootName: 'main',
					storePathHash: kept.storePathHash,
					storePath: kept.storePath
				}
			],
			narInfoHashes: [kept.storePathHash]
		});
	});
});
