import { rootLogger } from '@cupboard/logger';
import { startCapture } from '@cupboard/logger/testing';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import type { UploadId } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { narObjectKey } from '../http/http.ts';
import { OidcDiscoveryStore } from '../oidc/oidc.ts';
import { verifyTenant } from '../routing/scheduled.ts';
import {
	collectVerificationPasses,
	commitPath,
	currentServer,
	currentServerTenant,
	deferFreshUpload,
	expectSingleCommitDecision,
	expectSingleUploadDecision,
	initialise,
	markUploadCommitting,
	markUploadPendingVerification,
	negotiateUploads,
	pendingUploadVerdict,
	putNarBytes,
	resetTestServer,
	seedReservedNarInfo,
	uploadMetadata,
	verifiableNar,
	verifiablePath,
	verifyCurrentTenant
} from '../test-support.ts';

import { type CommitPipelineService } from './commit-pipeline-service.ts';
import { UploadStateService } from './upload-state-service.ts';
import {
	ActiveVerificationClaims,
	raceVerificationOperation
} from './verification-claim-lease.ts';
import { type VerificationService } from './verification-service.ts';

describe('verification RPC compatibility', () => {
	it('defers an ownerless claim from a preceding Durable Object', async () => {
		const requestVerificationPass = vi.fn(() => Promise.resolve());
		const previousServer = {
			claimVerificationBatchWithinBudget: vi.fn(() =>
				Promise.reject(new Error('RPC method is not available'))
			),
			claimVerificationBatch: vi.fn(() =>
				Promise.resolve({ claims: [], truncated: true })
			),
			requestVerificationPass
		};
		const namespace = {
			idFromName: vi.fn(() => ({}) as DurableObjectId),
			get: vi.fn(() => previousServer)
		};
		const compatibleEnv = {
			...env,
			CUPBOARD_DO: namespace
		} as unknown as Env;

		await verifyTenant(rootLogger(), compatibleEnv, currentServerTenant(), 10);

		expect({
			budgetedClaims:
				previousServer.claimVerificationBatchWithinBudget.mock.calls.length,
			compatibleClaims: previousServer.claimVerificationBatch.mock.calls.length,
			continuations: requestVerificationPass.mock.calls.length
		}).toStrictEqual({
			budgetedClaims: 1,
			compatibleClaims: 1,
			continuations: 1
		});
	});
});

async function deferUpload(
	token: string,
	seed: string,
	storePathHash: string
): Promise<{
	uploadId: UploadId;
	narHash: NixSha256HashString;
	r2Key: string;
	fileHash: NixSha256HashString;
	fileSize: number;
}> {
	const { metadata, nar } = await verifiablePath(seed, {
		storePathHash,
		name: seed
	});
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);
	await putNarBytes(upload.r2Key, nar);
	await markUploadPendingVerification(upload.uploadId);

	return {
		uploadId: upload.uploadId,
		narHash: metadata.narHash,
		r2Key: upload.r2Key,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	};
}

/**
 * Gives the verdict drain `attempts` turns. Each alarm applies as many held
 * verdicts as one invocation's D1 allowance covers, so a batch needs one turn
 * per verdict the recording invocation could not afford.
 */
async function drainRecordedVerdicts(attempts: number): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		await runInDurableObject(currentServer(), async (instance, state) => {
			await state.storage.deleteAlarm();
			await instance.alarm();
		});
	}
}

describe('batched verify fault isolation', () => {
	beforeEach(resetTestServer);

	it('settles a sibling when another verdict fails and leaves the failed upload pending', async () => {
		const token = await initialise();
		const failing = await deferUpload(token, 'apply-fails', 'a'.repeat(32));
		const sibling = await deferUpload(token, 'apply-ok', 'b'.repeat(32));

		// Fail only one upload's canonical object write. The consumer reports both
		// successful decodes, then the Durable Object promotes the sibling while
		// leaving the failed upload ready for another pass.
		const failingKey = narObjectKey(failing.narHash, 2);
		const originalPut = env.BLOBS.put.bind(env.BLOBS);
		const put = vi
			.spyOn(env.BLOBS, 'put')
			.mockImplementation((key, value, options) =>
				key === failingKey
					? Promise.reject(new Error('simulated promote outage'))
					: originalPut(key, value, options)
			);

		// Read the rows while the outage is still in place. The failed upload holds
		// its verdict, and the drain retries the application on every alarm, so a
		// restored object write would settle the row before it could be observed.
		try {
			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);

			// One invocation applies one verdict, so give the drain a turn for each
			// upload in the batch. Each pass resumes after the previous row, so the
			// failing upload does not delay its sibling.
			await drainRecordedVerdicts(2);

			expect({
				sibling: await pendingUploadVerdict(sibling.uploadId),
				failing: await pendingUploadVerdict(failing.uploadId)
			}).toStrictEqual({
				sibling: undefined,
				failing: 'pending'
			});
		} finally {
			put.mockRestore();
		}
	});

	it('keeps the Durable Object instance usable and the upload pending when D1 rejects inside the settle gate', async () => {
		const token = await initialise();
		const upload = await deferUpload(token, 'd1-fault', 'c'.repeat(32));

		// The runtime replaces a Durable Object whose gated callback throws. This
		// marker survives only if the current instance remains usable.
		const marker = new OidcDiscoveryStore();
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.discovery = marker;
		});

		// Fail the D1 status re-check that runs inside the settle's critical
		// section. The runtime breaks the whole object when the gated callback
		// itself throws, so the fault must surface as an ordinary rejection the
		// caller's per-verdict isolation absorbs.
		const statusQuery = 'select "status" from "tenant"';
		const originalPrepare = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
		const prepare = vi
			.spyOn(env.CUPBOARD_DB, 'prepare')
			.mockImplementation((query) => {
				if (typeof query === 'string' && query.startsWith(statusQuery)) {
					throw new Error('simulated D1 outage');
				}

				return originalPrepare(query);
			});

		// Keep the outage in place while the row is read. The upload holds its
		// verdict, and a restored status query would let the drain settle the row
		// before this assertion could see it pending.
		try {
			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);

			const isSameInstance = await runInDurableObject(
				currentServer(),
				(instance) => instance.context.discovery === marker
			);

			expect({
				verdict: await pendingUploadVerdict(upload.uploadId),
				isSameInstance
			}).toStrictEqual({ verdict: 'pending', isSameInstance: true });
		} finally {
			prepare.mockRestore();
		}
	});

	it('settles uploads when the prefetch D1 batch faults and falls back to per-path probes', async () => {
		const token = await initialise();
		const upload = await deferUpload(token, 'prefetch-fault', 'a'.repeat(32));

		// A new object first reserves version two and schedules deletion of the
		// legacy key in one batch. Reject the next batch, which prefetches object
		// metadata, then let subsequent calls through so the per-path probes succeed.
		const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let batchCallCount = 0;
		const batch = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation((...arguments_) => {
				batchCallCount += 1;

				return batchCallCount === 2
					? Promise.reject(new Error('simulated D1 prefetch fault'))
					: originalBatch(...arguments_);
			});

		try {
			await verifyCurrentTenant();
		} finally {
			batch.mockRestore();
		}

		expect(await pendingUploadVerdict(upload.uploadId)).toBeUndefined();
	});

	it('backs off without a continuation when a full batch applies nothing', async () => {
		const token = await initialise();
		const first = await deferUpload(token, 'all-fail-a', 'a'.repeat(32));
		const second = await deferUpload(token, 'all-fail-b', 'b'.repeat(32));

		// Every upload's promote fails, in the consumer (falling each verdict back
		// to plain verified) and again in the settle, so a full batch reaches the
		// apply step but settles nothing.
		const failingKeys = new Set<string>([
			narObjectKey(first.narHash, 2),
			narObjectKey(second.narHash, 2)
		]);
		const originalPut = env.BLOBS.put.bind(env.BLOBS);
		const put = vi
			.spyOn(env.BLOBS, 'put')
			.mockImplementation((key, value, options) =>
				failingKeys.has(key)
					? Promise.reject(new Error('simulated promote outage'))
					: originalPut(key, value, options)
			);

		const sent = await collectVerificationPasses();

		// Read the rows while the outage is still in place, for the reason the
		// sibling fixture gives: the drain retries a held verdict on every alarm.
		try {
			await verifyTenant(rootLogger(), env, currentServerTenant(), 2);

			expect({
				sent: sent.length,
				first: await pendingUploadVerdict(first.uploadId),
				second: await pendingUploadVerdict(second.uploadId)
			}).toStrictEqual({
				sent: 0,
				first: 'pending',
				second: 'pending'
			});
		} finally {
			put.mockRestore();
		}
	});

	it('does not continue a truncated batch after a stale verdict finds no row', async () => {
		const token = await initialise();
		const uploads = [
			await deferUpload(token, 'stale-gone', 'a'.repeat(32)),
			await deferUpload(token, 'still-waiting', 'b'.repeat(32))
		].toSorted((left, right) => left.uploadId.localeCompare(right.uploadId));
		const [stale, waiting] = uploads;

		if (stale === undefined || waiting === undefined) {
			throw new Error('The truncated verification fixture is incomplete.');
		}
		const sent = await collectVerificationPasses();
		const originalGet = env.BLOBS.get.bind(env.BLOBS);
		const { promise: held, resolve: release } =
			Promise.withResolvers<undefined>();
		const { promise: reached, resolve: didReach } =
			Promise.withResolvers<undefined>();
		const get = vi
			.spyOn(env.BLOBS, 'get')
			.mockImplementation(async (key, options) => {
				const object = await originalGet(key, options);

				if (key === stale.r2Key) {
					didReach(undefined);
					await held;
				}

				return object;
			});

		try {
			const stalePass = verifyTenant(
				rootLogger(),
				env,
				currentServerTenant(),
				1
			);

			await reached;
			await runInDurableObject(currentServer(), (instance) => {
				new UploadStateService(instance.context).markUploadPending(
					stale.uploadId
				);
			});
			const replacement = await currentServer().claimVerificationBatch(
				1,
				Number.MAX_SAFE_INTEGER
			);
			await runInDurableObject(currentServer(), (instance) => {
				expect(
					new UploadStateService(instance.context).clearPendingUpload(
						stale.uploadId,
						replacement.owner
					)
				).toBe(true);
			});
			release(undefined);
			await stalePass;
		} finally {
			get.mockRestore();
		}

		expect({
			sent: sent.length,
			stale: await pendingUploadVerdict(stale.uploadId),
			waiting: await pendingUploadVerdict(waiting.uploadId)
		}).toStrictEqual({
			sent: 0,
			stale: undefined,
			waiting: 'pending'
		});
	});

	it('logs a fixed classification when fresh verification fails', async () => {
		const token = await initialise();
		const upload = await deferUpload(token, 'cron-failure-log', 'a'.repeat(32));
		const originalGet = env.BLOBS.get.bind(env.BLOBS);
		const get = vi
			.spyOn(env.BLOBS, 'get')
			.mockImplementation((key, options) =>
				key === upload.r2Key
					? Promise.reject(new Error('simulated staging outage'))
					: originalGet(key, options)
			);
		const capture = startCapture();

		try {
			await verifyCurrentTenant();
		} finally {
			get.mockRestore();
			capture.stop();
		}

		const warnings = capture.logs
			.filter(
				(record) => record.message === 'pending upload verification failed'
			)
			.map((record) => ({
				level: record.level,
				message: record.message,
				properties: record.properties
			}));

		expect(warnings).toStrictEqual([
			{
				level: 'warning',
				message: 'pending upload verification failed',
				properties: { kind: 'fresh', reason: 'verification-failed' }
			}
		]);
	});

	it('stops a held recovery probe before the RPC leases fresh rows', async () => {
		const token = await initialise();
		const recovery = await deferFreshUpload(
			token,
			'held-recovery-probe',
			'a'.repeat(32)
		);
		const fresh = await deferFreshUpload(
			token,
			'fresh-after-held-probe',
			'b'.repeat(32)
		);
		await Promise.all([
			markUploadCommitting(recovery.uploadId),
			seedReservedNarInfo(recovery.metadata)
		]);
		const recoveryId = 'z-held-recovery' as UploadId;
		const freshId = 'a-fresh-after-held-probe' as UploadId;

		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				for (const [from, to] of [
					[recovery.uploadId, recoveryId],
					[fresh.uploadId, freshId]
				] as const) {
					instance.context.db
						.update(schema.pendingUploads)
						.set({ id: to })
						.where(eq(schema.pendingUploads.id, from))
						.run();
				}

				const verification = (
					instance as unknown as { verification: VerificationService }
				).verification;
				const pipeline = (
					verification as unknown as {
						commitPipeline: CommitPipelineService;
					}
				).commitPipeline;
				const { promise: held, resolve: release } =
					Promise.withResolvers<boolean>();
				const { promise: reached, resolve: didReach } =
					Promise.withResolvers<undefined>();
				const committedProbe = vi
					.spyOn(pipeline, 'isGenerationCommitted')
					.mockImplementation(async () => {
						didReach(undefined);

						return held;
					});
				const controller = new AbortController();
				const timer = setTimeout(() => {
					controller.abort(new SubrequestTimeoutError('nar.verify.batch'));
				}, 5);

				try {
					const rpc = instance.claimVerificationBatchWithinBudget(
						1,
						Number.MAX_SAFE_INTEGER,
						20
					);
					await reached;

					let isConsumerTimedOut = false;

					try {
						await raceVerificationOperation(rpc, controller.signal);
					} catch (error) {
						isConsumerTimedOut = error instanceof SubrequestTimeoutError;
					}

					const rpcResult = await rpc;
					release(false);

					const rows = instance.context.db
						.select({
							id: schema.pendingUploads.id,
							claimOwner: schema.pendingUploads.claimOwner,
							verdict: schema.pendingUploads.verdict
						})
						.from(schema.pendingUploads)
						.orderBy(schema.pendingUploads.id)
						.all()
						.map((row) => ({
							id: row.id,
							isClaimed: Boolean(row.claimOwner),
							verdict: row.verdict
						}));

					return {
						isConsumerTimedOut,
						isRpcTimedOut: rpcResult.kind === 'timed-out',
						rows
					};
				} finally {
					clearTimeout(timer);
					release(false);
					committedProbe.mockRestore();
				}
			}
		);

		expect(result).toStrictEqual({
			isConsumerTimedOut: true,
			isRpcTimedOut: true,
			rows: [
				{
					id: freshId,
					isClaimed: false,
					verdict: 'pending'
				},
				{
					id: recoveryId,
					isClaimed: false,
					verdict: 'committing'
				}
			]
		});
	});

	it('does not lease a no-decode row when cursor persistence times out', async () => {
		const token = await initialise();
		const nar = await verifiableNar('held-no-decode-cursor');
		const canonical = uploadMetadata({
			name: 'held-cursor-canonical',
			storePathHash: 'c'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		await commitPath(token, canonical, nar);
		const reuseMetadata = uploadMetadata({
			name: 'held-cursor-reuse',
			storePathHash: 'd'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [reuseMetadata]),
			reuseMetadata
		);
		await markUploadPendingVerification(reuse.uploadId);

		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const cursorKey = 'maintenance:verification-decode-free-cursor';
				await instance.context.ctx.storage.delete(cursorKey);
				const verification = (
					instance as unknown as { verification: VerificationService }
				).verification;
				const cursorStore = verification as unknown as {
					commitDecodeFreeClaim: (
						candidates: readonly (typeof schema.pendingUploads.$inferSelect)[],
						now: Date,
						owner: string,
						cursor: Readonly<Record<string, unknown>>
					) => Promise<void>;
					persistDecodeFreeCursor: () => Promise<void>;
				};
				const { promise: held, reject: fail } =
					Promise.withResolvers<undefined>();
				const { promise: reached, resolve: didReach } =
					Promise.withResolvers<undefined>();
				const persist = vi
					.spyOn(cursorStore, 'persistDecodeFreeCursor')
					.mockImplementation(async () => {
						didReach(undefined);

						return held;
					});
				try {
					const row = instance.context.db
						.select()
						.from(schema.pendingUploads)
						.where(eq(schema.pendingUploads.id, reuse.uploadId))
						.get();

					if (row === undefined) {
						throw new Error('expected the pending reuse fixture');
					}

					const claim = cursorStore.commitDecodeFreeClaim(
						[row],
						new Date(),
						crypto.randomUUID(),
						{ next: 'recovery', reuse: reuse.uploadId }
					);
					await reached;
					const rejects = expect(claim).rejects.toBeInstanceOf(
						SubrequestTimeoutError
					);
					fail(new SubrequestTimeoutError('do.storage.put'));
					await rejects;

					const claimed = instance.context.db
						.select({ claimOwner: schema.pendingUploads.claimOwner })
						.from(schema.pendingUploads)
						.where(eq(schema.pendingUploads.id, reuse.uploadId))
						.get();

					return { isClaimed: Boolean(claimed?.claimOwner) };
				} finally {
					fail(new SubrequestTimeoutError('do.storage.put'));
					persist.mockRestore();
				}
			}
		);

		expect(result).toStrictEqual({ isClaimed: false });
	});

	it('releases a no-decode lease when a held prepare reaches the RPC deadline', async () => {
		const token = await initialise();
		const nar = await verifiableNar('held-reuse-prepare');
		const canonical = uploadMetadata({
			name: 'held-reuse-canonical',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		await commitPath(token, canonical, nar);
		const reuseMetadata = uploadMetadata({
			name: 'held-reuse',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [reuseMetadata]),
			reuseMetadata
		);
		await markUploadPendingVerification(reuse.uploadId);

		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const verification = (
					instance as unknown as { verification: VerificationService }
				).verification;
				const prepareTarget = verification as unknown as {
					prepareWithoutDecode: () => Promise<unknown>;
				};
				const held = Promise.withResolvers<unknown>();
				const reached = Promise.withResolvers<undefined>();
				const prepare = vi
					.spyOn(prepareTarget, 'prepareWithoutDecode')
					.mockImplementation(() => {
						reached.resolve(undefined);

						return held.promise;
					});

				try {
					const rpc = instance.claimVerificationBatchWithinBudget(
						1,
						Number.MAX_SAFE_INTEGER,
						20
					);
					await reached.promise;
					const rpcResult = await rpc;
					const row = instance.context.db
						.select({ claimOwner: schema.pendingUploads.claimOwner })
						.from(schema.pendingUploads)
						.where(eq(schema.pendingUploads.id, reuse.uploadId))
						.get();

					return {
						isTimedOut: rpcResult.kind === 'timed-out',
						isClaimed: Boolean(row?.claimOwner)
					};
				} finally {
					held.resolve({ kind: 'ignored' });
					prepare.mockRestore();
				}
			}
		);

		expect(result).toStrictEqual({ isTimedOut: true, isClaimed: false });
	});

	it('keeps a verdict ID active when the record deadline wins', async () => {
		const uploadId = 'retry-after-record-deadline' as UploadId;
		const timeout = new SubrequestTimeoutError('verification.record');
		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const verification = (
					instance as unknown as { verification: VerificationService }
				).verification;
				const activeClaims = new ActiveVerificationClaims([uploadId]);
				const controller = new AbortController();
				// Recording an abandoned verdict only updates local SQLite and finishes
				// synchronously. Abort before the call to model an expired deadline.
				controller.abort(timeout);

				let isTimedOut = false;

				try {
					await verification.recordVerifications(
						rootLogger(),
						'owner',
						[{ uploadId, verdict: { kind: 'abandoned' } }],
						controller.signal
					);
					activeClaims.recorded([uploadId]);
				} catch (error) {
					isTimedOut = error === timeout;
				}

				return { isTimedOut, remaining: activeClaims.remaining() };
			}
		);

		expect(result).toStrictEqual({
			isTimedOut: true,
			remaining: [uploadId]
		});
	});

	it('stops one stalled decode wave at the consumer deadline without requesting a continuation', async () => {
		const token = await initialise();
		const uploads = await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				deferUpload(
					token,
					`batch-deadline-${String(index)}`,
					String(index).repeat(32)
				)
			)
		);
		const stagingKeys = new Set(uploads.map((upload) => upload.r2Key));
		const originalGet = env.BLOBS.get.bind(env.BLOBS);
		const held: (() => void)[] = [];
		const waveStarted = Promise.withResolvers<undefined>();
		let isReleased = false;
		let started = 0;
		const get = vi
			.spyOn(env.BLOBS, 'get')
			.mockImplementation(async (key, options) => {
				const object = await originalGet(key, options);

				if (isReleased || !stagingKeys.has(key)) {
					return object;
				}

				started += 1;

				if (started === 4) {
					waveStarted.resolve(undefined);
				}

				await new Promise<void>((resolve) => {
					held.push(resolve);
				});

				return object;
			});
		const sent = await collectVerificationPasses();
		const pass = verifyTenant(
			rootLogger(),
			env,
			currentServerTenant(),
			5,
			Number.MAX_SAFE_INTEGER,
			500
		);
		const observedPass = (async (): Promise<
			| { readonly outcome: 'resolved' }
			| { readonly outcome: 'rejected'; readonly error: unknown }
		> => {
			try {
				await pass;

				return { outcome: 'resolved' };
			} catch (error: unknown) {
				return { outcome: 'rejected', error };
			}
		})();
		const startedWave = (async (): Promise<{
			readonly outcome: 'started';
		}> => {
			await waveStarted.promise;

			return { outcome: 'started' };
		})();

		try {
			const first = await Promise.race([startedWave, observedPass]);
			const observed = await observedPass;

			expect({
				first: first.outcome,
				outcome: observed.outcome,
				isTimeout:
					observed.outcome === 'rejected' &&
					observed.error instanceof SubrequestTimeoutError,
				started,
				continuations: sent.length
			}).toStrictEqual({
				first: 'started',
				outcome: 'rejected',
				isTimeout: true,
				started: 4,
				continuations: 0
			});
		} finally {
			isReleased = true;

			for (const release of held) {
				release();
			}

			await observedPass;
			get.mockRestore();
		}
	});

	it('bounds a stalled promotion by the verdict RPC budget', async () => {
		const token = await initialise();
		const upload = await deferUpload(
			token,
			'promotion-deadline',
			'a'.repeat(32)
		);
		const claim = await currentServer().claimVerificationBatch(
			1,
			Number.MAX_SAFE_INTEGER
		);
		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				vi.useFakeTimers();

				const canonicalKey = narObjectKey(upload.narHash, 2);
				const originalPut = env.BLOBS.put.bind(env.BLOBS);
				const promotionStarted = Promise.withResolvers<undefined>();
				const releasePromotion = Promise.withResolvers<undefined>();
				const pendingPromotions: Promise<R2Object>[] = [];
				const put = vi
					.spyOn(env.BLOBS, 'put')
					.mockImplementation((key, value, options) => {
						if (key === canonicalKey) {
							const promotion = (async (): Promise<R2Object> => {
								promotionStarted.resolve(undefined);
								await releasePromotion.promise;

								return originalPut(key, value, options);
							})();
							pendingPromotions.push(promotion);

							return promotion;
						}

						return originalPut(key, value, options);
					});

				try {
					const rpc = instance.recordVerificationsWithinBudget(
						claim.owner,
						[
							{
								uploadId: upload.uploadId,
								verdict: {
									kind: 'verified',
									verification: {
										ok: true,
										fileHash: upload.fileHash,
										fileSize: upload.fileSize
									}
								}
							}
						],
						40
					);
					await promotionStarted.promise;
					await vi.advanceTimersByTimeAsync(40);
					const rpcResult = await rpc;
					const row = instance.context.db
						.select({ verdict: schema.pendingUploads.verdict })
						.from(schema.pendingUploads)
						.where(eq(schema.pendingUploads.id, upload.uploadId))
						.get();

					return {
						kind: rpcResult.kind,
						verdict: row?.verdict
					};
				} finally {
					releasePromotion.resolve(undefined);
					await Promise.allSettled(pendingPromotions);
					put.mockRestore();
					vi.useRealTimers();
				}
			}
		);

		expect(result).toStrictEqual({ kind: 'timed-out', verdict: 'pending' });
	});
});
