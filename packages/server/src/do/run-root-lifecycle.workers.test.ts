import {
	DEFAULT_CACHE,
	graceSecondsSchema,
	rootNameSchema,
	storePathHashSchema,
	storePathSchema,
	WIRE_DEFAULT_CACHE
} from '@cupboard/nix-store/scalars';
import { rootSetMaxTargets } from '@cupboard/protocol/retention';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
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
	uploadPathNegotiation
} from '../test-support.ts';

const runRoot: UploadAttachRoot = { name: 'ci/run-1', ttlSeconds: 3600 };
// The Durable Object's SQLite caps bound variables per statement, so seeding
// inserts in small row batches.
const seedInsertBatchSize = 20;

async function negotiateWithRoot(
	token: string,
	paths: readonly ReturnType<typeof uploadMetadata>[],
	attachRoot?: UploadAttachRoot
): Promise<UploadNegotiateResponse> {
	const response = await authorisedFetch(
		`/cache/${WIRE_DEFAULT_CACHE}/uploads`,
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

// Runs one path through negotiate, upload and commit under a run root, the
// way a build-time push does.
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

async function retentionRootRows(): Promise<readonly unknown[]> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select()
			.from(schema.retentionRoots)
			.all()
			.map((row) => ({ ...row, expiresAt: row.expiresAt ?? undefined }))
			.toSorted((left, right) => left.name.localeCompare(right.name))
	);
}

// A synthetic already-attached target, the shape a long run's earlier batches
// left behind: a valid hash and path that never need to be servable for the
// attach bound question.
function seededTarget(index: number): {
	storePathHash: string;
	storePath: string;
} {
	const suffix = String(index).padStart(4, '0');
	const storePathHash = `${'a'.repeat(28)}${suffix}`;

	return {
		storePathHash,
		storePath: `/nix/store/${storePathHash}-seed-${suffix}`
	};
}

async function seedRunRootTargets(count: number): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		for (let offset = 0; offset < count; offset += seedInsertBatchSize) {
			const rows: (typeof schema.retentionRootTargets.$inferInsert)[] =
				Array.from(
					{ length: Math.min(seedInsertBatchSize, count - offset) },
					(_, index) => {
						const target = seededTarget(offset + index);

						return {
							cache: DEFAULT_CACHE,
							rootName: rootNameSchema.parse(runRoot.name),
							storePathHash: storePathHashSchema.parse(target.storePathHash),
							storePath: storePathSchema.parse(target.storePath)
						};
					}
				);

			instance.context.db
				.insert(schema.retentionRootTargets)
				.values(rows)
				.run();
		}
	});
}

// A tenant-wide grace policy: released targets receive a deadline under it.
async function enableGracePolicy(): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.insert(schema.retentionGracePolicies)
			.values({
				id: 'policy-under-test',
				cachePrefix: '',
				graceSeconds: graceSecondsSchema.parse(3600),
				createdAt: isoTimestampSchema.parse(testBase.toISOString())
			})
			.run();
	});
}

describe('run root lifecycle', () => {
	beforeEach(resetTestServer);

	it('attaches past the per-request target bound without failing', async () => {
		const token = await initialise();
		const gated = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'gated',
			storePathHash: 'b'.repeat(32)
		});

		// The bound applies to one set-root request, never to a root: a long
		// run's earlier batches already attached a full request's worth, and
		// the next commit still attaches through the gate.
		await seedRunRootTargets(rootSetMaxTargets);
		await pushWithRoot(token, gated, runRoot);

		const rows = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db.select().from(schema.retentionRootTargets).all()
		);
		const gatedRows = rows.filter(
			(row) => row.storePathHash === gated.storePathHash
		);

		expect({ total: rows.length, gatedRows }).toStrictEqual({
			total: rootSetMaxTargets + 1,
			gatedRows: [
				{
					cache: '',
					rootName: runRoot.name,
					storePathHash: gated.storePathHash,
					storePath: gated.storePath
				}
			]
		});
	});

	it('replaying permuted batches leaves the same attached row set', async () => {
		const token = await initialise();
		const first = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'first',
			storePathHash: 'a'.repeat(32)
		});
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'second',
			storePathHash: 'b'.repeat(32)
		});

		// The interrupted shape: one target row already applied while the
		// settle that wrote it never finished.
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.retentionRootTargets)
				.values({
					cache: DEFAULT_CACHE,
					rootName: rootNameSchema.parse(runRoot.name),
					storePathHash: first.storePathHash,
					storePath: first.storePath
				})
				.run();
		});

		await pushWithRoot(token, first, runRoot);
		await pushWithRoot(token, second, runRoot);
		const afterFirstPass = await rootTargetRows();

		// The whole sequence re-driven in the reverse order: every commit
		// negotiates as already present and attach applies nothing new.
		await pushWithRoot(token, second, runRoot);
		await pushWithRoot(token, first, runRoot);

		const expected = [
			{
				cache: '',
				rootName: runRoot.name,
				storePathHash: first.storePathHash,
				storePath: first.storePath
			},
			{
				cache: '',
				rootName: runRoot.name,
				storePathHash: second.storePathHash,
				storePath: second.storePath
			}
		];

		expect({
			afterFirstPass,
			afterReplay: await rootTargetRows()
		}).toStrictEqual({ afterFirstPass: expected, afterReplay: expected });
	});

	it('replacing a target root leaves the run root undisturbed', async () => {
		const token = await initialise();
		const previous = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'previous',
			storePathHash: 'a'.repeat(32)
		});
		const next = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'next',
			storePathHash: 'b'.repeat(32)
		});

		// The released target is deliberately outside the run root, so losing
		// its target root really releases it; the replacement target is run-root
		// attached like any streamed path.
		await pushWithRoot(token, previous);
		await pushWithRoot(token, next, runRoot);
		await setRoot(token, { name: 'main', targets: [previous.storePath] });
		await enableGracePolicy();

		// Reconciliation replaces the target root; the released target gains
		// grace, and the run root's rows and expiry stay exactly as attached.
		await setRoot(token, { name: 'main', targets: [next.storePath] });

		const grace = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({ storePathHash: schema.retentionGrace.storePathHash })
				.from(schema.retentionGrace)
				.all()
				.map((row) => row.storePathHash)
		);

		expect({
			roots: await retentionRootRows(),
			targets: await rootTargetRows(),
			grace
		}).toStrictEqual({
			roots: [
				{
					cache: '',
					name: runRoot.name,
					expiresAt: '2026-01-01T01:00:00.000Z',
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z'
				},
				{
					cache: '',
					name: 'main',
					expiresAt: undefined,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z'
				}
			],
			targets: [
				{
					cache: '',
					rootName: runRoot.name,
					storePathHash: next.storePathHash,
					storePath: next.storePath
				},
				{
					cache: '',
					rootName: 'main',
					storePathHash: next.storePathHash,
					storePath: next.storePath
				}
			],
			grace: [previous.storePathHash]
		});
	});

	it('multi-batch attachments stay servable until the run root expires', async () => {
		const token = await initialise();
		const kept = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'kept',
			storePathHash: 'a'.repeat(32)
		});
		const batchOne = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'batch-one',
			storePathHash: 'b'.repeat(32)
		});
		const batchTwo = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'batch-two',
			storePathHash: 'c'.repeat(32)
		});

		await pushWithRoot(token, kept);
		await setRoot(token, { name: 'main', targets: [kept.storePath] });
		await pushWithRoot(token, batchOne, runRoot);
		await pushWithRoot(token, batchTwo, runRoot);

		const whileLive = await runGcResult();

		// Past the run root's expiry, both batches' attachments have nothing
		// retaining them; the permanently rooted path stays.
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
				pathsSwept: 0,
				narInfosDeleted: 0,
				orphanStagingDeleted: 0
			},
			afterExpiry: {
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 1,
				pathsSwept: 2,
				narInfosDeleted: 2,
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

	it('a skip-attached path outlives the run root that first published it', async () => {
		const token = await initialise();
		const shared = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'shared',
			storePathHash: 'a'.repeat(32)
		});

		await pushWithRoot(token, shared, runRoot);

		// The second run's negotiate answers the shared path as a skip; its
		// longer-lived root must hold the path once the first run's expires.
		const decision = singleDecision(
			await negotiateWithRoot(token, [shared], {
				name: 'ci/run-2',
				ttlSeconds: 7200
			})
		);

		// Between the two expiries only the first run root has lapsed, and the
		// second's attachment keeps the shared path servable.
		vi.setSystemTime(new Date(testBase.getTime() + 1.5 * 3600 * 1000));
		const afterFirstExpiry = await runGcResult();
		const heldTargets = await rootTargetRows();

		// Past the second run root's expiry, nothing retains the shared path.
		vi.setSystemTime(new Date(testBase.getTime() + 3 * 3600 * 1000));
		const afterSecondExpiry = await runGcResult();

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
			action: decision.action,
			afterFirstExpiry,
			heldTargets,
			afterSecondExpiry,
			targets: await rootTargetRows(),
			narInfoHashes
		}).toStrictEqual({
			action: 'skip',
			afterFirstExpiry: {
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 1,
				pathsSwept: 0,
				narInfosDeleted: 0,
				orphanStagingDeleted: 0
			},
			heldTargets: [
				{
					cache: '',
					rootName: 'ci/run-2',
					storePathHash: shared.storePathHash,
					storePath: shared.storePath
				}
			],
			afterSecondExpiry: {
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 1,
				pathsSwept: 1,
				narInfosDeleted: 1,
				orphanStagingDeleted: 0
			},
			targets: [],
			narInfoHashes: []
		});
	});

	it('a second push substitutes shared work while the run root is live', async () => {
		const token = await initialise();
		const shared = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'shared',
			storePathHash: 'a'.repeat(32)
		});

		await pushWithRoot(token, shared, runRoot);

		// The second cohort's negotiate finds the shared path already
		// canonical: nothing to upload, and collection while the first run
		// root is live reclaims nothing.
		const decision = singleDecision(
			await negotiateWithRoot(token, [shared], {
				name: 'ci/run-2',
				ttlSeconds: 3600
			})
		);

		expect({
			action: decision.action,
			storePathHash: decision.storePathHash,
			gc: await runGcResult()
		}).toStrictEqual({
			action: 'skip',
			storePathHash: shared.storePathHash,
			gc: {
				ok: true,
				pendingUploadsDeleted: 0,
				pendingAttestationsDeleted: 0,
				rootsExpired: 0,
				pathsSwept: 0,
				narInfosDeleted: 0,
				orphanStagingDeleted: 0
			}
		});
	});
});
