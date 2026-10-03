import { rootLogger } from '@cupboard/logger';
import { subrequestSafetyReserve } from '@cupboard/protocol/platform';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import { narInfos, pendingUploads } from '../db/schema.ts';
import {
	SubrequestSliceExceededError,
	SubrequestTimeoutError
} from '../errors.ts';
import { narObjectKeyPrefix } from '../http/http.ts';
import {
	asOneInvocation,
	collectVerificationPasses,
	currentServer,
	deferFreshUpload,
	flakyD1,
	initialise,
	resetTestServer,
	syntheticStorePathHash,
	useTestServer,
	withDeployedSubrequestAllowance,
	withoutAlarmArming
} from '../test-support.ts';

import { boundedD1 } from './bounded-io.ts';
import { maintenancePassCursorKey } from './server.ts';
import { withSubrequestSlice } from './subrequest-slice.ts';
import { UploadStateService } from './upload-state-service.ts';
import {
	pendingSettlePrefetchSubrequests,
	type PendingVerificationBatch,
	recordedVerdictCursorKey,
	type RecordedVerdictPage,
	subrequestsPerRecordedVerdict,
	type VerificationResult,
	VerificationService
} from './verification-service.ts';

type DeferredUpload = Awaited<ReturnType<typeof deferFreshUpload>>;

const pushConcurrency = 6;

/**
 * Stages `count` fresh uploads with bytes unique to this fixture. The distinct
 * seeds ensure each promotion must write a new canonical object.
 */
async function deferFreshUploads(
	server: string,
	count: number,
	seedPrefix: string,
	indexOffset: number
): Promise<readonly DeferredUpload[]> {
	await useTestServer(server);

	const token = await initialise();

	// Claiming and completing a row both enqueue another verification pass.
	// Capture those requests locally so the fixture's consumer need not drain
	// the queue before the gate reopens.
	await collectVerificationPasses();

	const deferred: DeferredUpload[] = [];

	for (let start = 0; start < count; start += pushConcurrency) {
		const group = await Promise.all(
			Array.from(
				{ length: Math.min(pushConcurrency, count - start) },
				(_, offset) =>
					deferFreshUpload(
						token,
						`${seedPrefix}-${String(start + offset)}`,
						syntheticStorePathHash(indexOffset + start + offset)
					)
			)
		);
		deferred.push(...group);
	}

	return deferred;
}

function verifiedResults(
	claims: PendingVerificationBatch['claims'],
	uploads: readonly DeferredUpload[]
): VerificationResult[] {
	const byUploadId = new Map(
		uploads.map((upload) => [upload.uploadId, upload] as const)
	);

	return claims.map((claim) => {
		const upload = byUploadId.get(claim.uploadId);

		if (upload === undefined) {
			throw new Error(
				'The claim refers to an upload the fixture did not stage.'
			);
		}

		return {
			uploadId: claim.uploadId,
			verdict: {
				kind: 'verified',
				verification: {
					ok: true,
					fileHash: upload.nar.fileHash,
					fileSize: upload.nar.narBytes.byteLength
				}
			}
		} satisfies VerificationResult;
	});
}

async function driveInterruptedVerdict(server: string): Promise<{
	readonly heldAfterRecord: number;
	readonly verdictAfterRecord: string | null | undefined;
	readonly edgesAfterRecord: number;
	readonly claimsWhileHeld: number;
	readonly claimsBeforeRetry: number;
	readonly claimsAfterRevoke: number;
	readonly heldAfterDrain: number;
	readonly pendingAfterDrain: number;
	readonly pathsAfterDrain: number;
	readonly edgesAfterDrain: number;
	readonly edgesAfterSecondAlarm: number;
}> {
	const [upload] = await deferFreshUploads(server, 1, 'interrupted', 200);

	if (upload === undefined) {
		throw new Error('The interrupted verdict fixture staged no upload.');
	}

	const originalPut = env.BLOBS.put.bind(env.BLOBS);
	const put = vi
		.spyOn(env.BLOBS, 'put')
		.mockImplementation((key, value, options) =>
			key.startsWith(narObjectKeyPrefix) &&
			key.includes(upload.metadata.narHash)
				? Promise.reject(new Error('simulated promote outage'))
				: originalPut(key, value, options)
		);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const claim = await instance.claimVerificationBatch(
			1,
			Number.MAX_SAFE_INTEGER
		);
		const local = drizzle(state.storage, {
			schema: { narInfos, pendingUploads }
		});
		const heldVerdicts = (): number =>
			local
				.select({ id: pendingUploads.id })
				.from(pendingUploads)
				.where(isNotNull(pendingUploads.recordedVerdictJson))
				.all().length;
		const committedPaths = (): number =>
			local
				.select({ storePathHash: narInfos.storePathHash })
				.from(narInfos)
				.all().length;
		// Charging a commit writes its reference edge. Count those edges to detect
		// duplicate commits to the shared database.
		const edgeFilter = and(
			eq(d1Schema.blobReference.tenant, instance.context.requireTenant()),
			eq(d1Schema.blobReference.storePathHash, upload.metadata.storePathHash)
		);
		const edgeCount = async (): Promise<number> => {
			const edges = await instance.context.d1
				.select({ narHash: d1Schema.blobReference.narHash })
				.from(d1Schema.blobReference)
				.where(edgeFilter)
				.all();

			return edges.length;
		};

		const advanceToRetryDeadline = (): void => {
			const deadline = local
				.select({ readyAt: pendingUploads.settleRetryAfter })
				.from(pendingUploads)
				.where(eq(pendingUploads.id, upload.uploadId))
				.get()?.readyAt;

			if (deadline == undefined) {
				throw new Error(
					'The interrupted promotion did not record a retry deadline.'
				);
			}

			vi.setSystemTime(new Date(deadline));
		};

		try {
			await state.storage.deleteAlarm();
			await instance.recordVerifications(
				claim.owner,
				verifiedResults(claim.claims, [upload])
			);

			const heldAfterRecord = heldVerdicts();
			const verdictAfterRecord = local
				.select({ verdict: pendingUploads.verdict })
				.from(pendingUploads)
				.where(eq(pendingUploads.id, upload.uploadId))
				.get()?.verdict;
			const edgesAfterRecord = await edgeCount();
			const whileHeld = await instance.claimVerificationBatch(
				1,
				Number.MAX_SAFE_INTEGER
			);

			new UploadStateService(instance.context).markUploadPending(
				upload.uploadId
			);
			const beforeRetry = await instance.claimVerificationBatch(
				1,
				Number.MAX_SAFE_INTEGER
			);
			advanceToRetryDeadline();
			const afterRevoke = await instance.claimVerificationBatch(
				1,
				Number.MAX_SAFE_INTEGER
			);

			// Put the verdict back the way the interrupted invocation left it, so
			// the drain has something to apply once promotion works again.
			await instance.recordVerifications(
				afterRevoke.owner,
				verifiedResults(afterRevoke.claims, [upload])
			);

			// Promotion works again from here, so the next alarm's drain can settle
			// the row it left holding a verdict.
			put.mockRestore();
			advanceToRetryDeadline();
			await state.storage.deleteAlarm();
			await instance.alarm();

			const heldAfterDrain = heldVerdicts();
			const pendingAfterDrain = local
				.select({ id: pendingUploads.id })
				.from(pendingUploads)
				.all().length;
			const pathsAfterDrain = committedPaths();
			const edgesAfterDrain = await edgeCount();

			await state.storage.deleteAlarm();
			await instance.alarm();

			return {
				heldAfterRecord,
				verdictAfterRecord,
				edgesAfterRecord,
				claimsWhileHeld: whileHeld.claims.length,
				claimsBeforeRetry: beforeRetry.claims.length,
				claimsAfterRevoke: afterRevoke.claims.length,
				heldAfterDrain,
				pendingAfterDrain,
				pathsAfterDrain,
				edgesAfterDrain,
				edgesAfterSecondAlarm: await edgeCount()
			};
		} finally {
			put.mockRestore();
		}
	});
}

describe('recorded verdict durability', () => {
	beforeEach(resetTestServer);

	it.each(['absent', 'legacy'] as const)(
		'continues recorded verdicts in readiness order when the cursor is %s',
		async (cursorKind) => {
			const uploads = await deferFreshUploads(
				`recorded-cursor-${cursorKind}`,
				2,
				'cursor',
				900
			);
			const measured = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const claim = await instance.claimVerificationBatch(
						2,
						Number.MAX_SAFE_INTEGER
					);
					const local = drizzle(state.storage, { schema: { pendingUploads } });
					const earlierId = uploadIdSchema.parse('z-earlier-ready');
					const laterId = uploadIdSchema.parse('a-later-ready');
					for (const [index, result] of verifiedResults(
						claim.claims,
						uploads
					).entries()) {
						local
							.update(pendingUploads)
							.set({
								id: index === 0 ? earlierId : laterId,
								recordedVerdictJson: JSON.stringify({
									owner: claim.owner,
									verdict: result.verdict
								}),
								...(index === 1 && {
									settleRetryAfter: isoTimestamp(new Date(0))
								})
							})
							.where(eq(pendingUploads.id, result.uploadId))
							.run();
					}
					await state.storage.delete(recordedVerdictCursorKey);
					if (cursorKind === 'legacy') {
						await state.storage.put(recordedVerdictCursorKey, earlierId);
					}
					const verification = (
						instance as unknown as { verification: VerificationService }
					).verification;
					const preparation = verification as unknown as {
						prepareRecordedVerdict: (
							pending: typeof pendingUploads.$inferSelect
						) => Promise<unknown>;
					};
					const prepare = vi
						.spyOn(preparation, 'prepareRecordedVerdict')
						.mockRejectedValue(
							new SubrequestSliceExceededError('verdict preparation', 1)
						);
					try {
						for (let pass = 0; pass < 3; pass++) {
							await withSubrequestSlice(
								() => verification.applyRecordedVerdicts(rootLogger()),
								{
									subrequests:
										subrequestSafetyReserve +
										pendingSettlePrefetchSubrequests +
										subrequestsPerRecordedVerdict +
										1
								}
							);
						}
						const failures = local
							.select({
								id: pendingUploads.id,
								count: pendingUploads.settleFailures
							})
							.from(pendingUploads)
							.orderBy(pendingUploads.id)
							.all();
						return {
							attempts: prepare.mock.calls.map(([pending]) => pending.id),
							failures
						};
					} finally {
						prepare.mockRestore();
					}
				}
			);
			const earlierId = uploadIdSchema.parse('z-earlier-ready');
			const laterId = uploadIdSchema.parse('a-later-ready');
			expect(measured).toStrictEqual({
				attempts: [earlierId, laterId, earlierId],
				failures: [
					{ id: laterId, count: 0 },
					{ id: earlierId, count: 0 }
				]
			});
		}
	);

	it.each(['cursor write', 'preparation', 'materialisation'] as const)(
		'applies a recorded verdict once when another drain overlaps its %s',
		async (boundary) => {
			await withoutAlarmArming(async () => {
				const token = await initialise();
				const upload = await deferFreshUpload(
					token,
					`recorded-overlap-${boundary.replaceAll(' ', '-')}`,
					'f'.repeat(32)
				);
				const claim = await currentServer().claimVerificationBatch(
					1,
					Number.MAX_SAFE_INTEGER
				);
				const results = verifiedResults(claim.claims, [upload]);
				const recorded = JSON.stringify({
					owner: claim.owner,
					verdict: results[0]?.verdict
				});
				const now = Date.now();
				const measured = await runInDurableObject(
					currentServer(),
					async (instance, state) => {
						const verification: unknown = Reflect.get(instance, 'verification');
						if (!(verification instanceof VerificationService)) {
							throw new TypeError(
								'The test server has no verification service.'
							);
						}
						const method =
							boundary === 'materialisation'
								? 'materialiseVerified'
								: 'prepareRecordedVerdict';
						const target: unknown = Reflect.get(verification, method);
						if (typeof target !== 'function') {
							throw new TypeError('The verdict application method is missing.');
						}
						const originalMethod = Object.getOwnPropertyDescriptor(
							verification,
							method
						);
						let didInterleave = false;
						let overlapping: number | undefined;
						const interleave = async (): Promise<void> => {
							if (didInterleave) {
								return;
							}
							didInterleave = true;
							overlapping = await asOneInvocation(() =>
								instance.recordVerifications(claim.owner, [])
							);
						};
						const attempt = vi.fn(async () => {
							if (boundary !== 'cursor write') {
								await interleave();
							}
							throw new Error('controlled provider failure');
						});
						Object.defineProperty(verification, method, {
							configurable: true,
							value: attempt
						});
						const originalPut = state.storage.put.bind(state.storage);
						const put = vi
							.spyOn(state.storage, 'put')
							.mockImplementation(
								async (
									key: string | Record<string, unknown>,
									value?: unknown,
									options?: DurableObjectPutOptions
								) => {
									if (
										key === recordedVerdictCursorKey &&
										boundary === 'cursor write'
									) {
										await interleave();
									}
									if (typeof key !== 'string') {
										throw new TypeError(
											'The fixture expects a keyed storage write.'
										);
									}
									return originalPut(key, value, options);
								}
							);
						const row = () => {
							const pending = instance.context.db
								.select({
									failures: pendingUploads.settleFailures,
									retryAfter: pendingUploads.settleRetryAfter,
									category: pendingUploads.lastSettleError,
									recorded: pendingUploads.recordedVerdictJson,
									owner: pendingUploads.claimOwner,
									startedAt: pendingUploads.retryStartedActiveMs,
									exhaustion: pendingUploads.settleExhaustion
								})
								.from(pendingUploads)
								.where(eq(pendingUploads.id, upload.uploadId))
								.get();
							return pending === undefined
								? undefined
								: { ...pending, exhaustion: pending.exhaustion ?? undefined };
						};
						try {
							const first = await asOneInvocation(() =>
								instance.recordVerifications(claim.owner, results)
							);
							const afterOverlap = {
								attempts: attempt.mock.calls.length,
								row: row()
							};
							const beforeRetry = await asOneInvocation(() =>
								instance.recordVerifications(claim.owner, [])
							);
							const waiting = {
								attempts: attempt.mock.calls.length,
								row: row()
							};
							vi.setSystemTime(now + 30_000);
							const retry = await asOneInvocation(() =>
								instance.recordVerifications(claim.owner, [])
							);
							return {
								first,
								overlapping,
								beforeRetry,
								retry,
								didInterleave,
								afterOverlap,
								waiting,
								retried: { attempts: attempt.mock.calls.length, row: row() }
							};
						} finally {
							put.mockRestore();
							if (originalMethod === undefined) {
								Reflect.deleteProperty(verification, method);
							} else {
								Object.defineProperty(verification, method, originalMethod);
							}
						}
					}
				);
				const firstRow = {
					failures: 1,
					retryAfter: new Date(now + 30_000).toISOString(),
					category:
						boundary === 'materialisation'
							? 'materialisation-failed'
							: 'prepare-failed',
					recorded,
					owner: claim.owner,
					startedAt: 0,
					exhaustion: undefined
				};
				expect(measured).toStrictEqual({
					first: 0,
					overlapping: 0,
					beforeRetry: 0,
					retry: 0,
					didInterleave: true,
					afterOverlap: { attempts: 1, row: firstRow },
					waiting: { attempts: 1, row: firstRow },
					retried: {
						attempts: 2,
						row: {
							...firstRow,
							failures: 2,
							retryAfter: new Date(now + 90_000).toISOString()
						}
					}
				});
			});
		}
	);

	it('releases an aborted application claim so a public RPC can continue its verdict', async () => {
		await withoutAlarmArming(async () => {
			const token = await initialise();
			const upload = await deferFreshUpload(
				token,
				'recorded-abort',
				'f'.repeat(32)
			);
			const claim = await currentServer().claimVerificationBatch(
				1,
				Number.MAX_SAFE_INTEGER
			);
			const results = verifiedResults(claim.claims, [upload]);
			const recorded = JSON.stringify({
				owner: claim.owner,
				verdict: results[0]?.verdict
			});
			const observed = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const verification: unknown = Reflect.get(instance, 'verification');
					if (!(verification instanceof VerificationService)) {
						throw new TypeError('The test server has no verification service.');
					}
					const controller = new AbortController();
					const timeout = new SubrequestTimeoutError('verification.record');
					const attempt = vi.fn(() => {
						controller.abort(timeout);
						return Promise.reject(timeout);
					});
					Object.defineProperty(verification, 'prepareRecordedVerdict', {
						configurable: true,
						value: attempt
					});
					const row = () => {
						const pending = instance.context.db
							.select({
								failures: pendingUploads.settleFailures,
								retryAfter: pendingUploads.settleRetryAfter,
								recorded: pendingUploads.recordedVerdictJson,
								owner: pendingUploads.claimOwner,
								startedAt: pendingUploads.retryStartedActiveMs
							})
							.from(pendingUploads)
							.where(eq(pendingUploads.id, upload.uploadId))
							.get();
						return pending === undefined
							? undefined
							: { ...pending, retryAfter: pending.retryAfter ?? undefined };
					};
					try {
						await expect(
							asOneInvocation(() =>
								verification.recordVerifications(
									rootLogger(),
									claim.owner,
									results,
									controller.signal
								)
							)
						).rejects.toBe(timeout);
						const interrupted = row();
						Reflect.deleteProperty(verification, 'prepareRecordedVerdict');
						const continued = await asOneInvocation(() =>
							instance.recordVerifications(claim.owner, [])
						);
						return {
							attempts: attempt.mock.calls.length,
							interrupted,
							continued,
							remaining: row()
						};
					} finally {
						Reflect.deleteProperty(verification, 'prepareRecordedVerdict');
					}
				}
			);
			expect(observed).toStrictEqual({
				attempts: 1,
				interrupted: {
					failures: 0,
					retryAfter: undefined,
					recorded,
					owner: claim.owner,
					startedAt: 0
				},
				continued: 1,
				remaining: undefined
			});
		});
	});

	it('retains an interrupted verdict and applies it once on a later pass', async () => {
		const driven = await driveInterruptedVerdict(
			'verify-allowance-interrupted'
		);

		expect(driven).toStrictEqual({
			heldAfterRecord: 1,
			verdictAfterRecord: 'pending',
			edgesAfterRecord: 0,
			claimsWhileHeld: 0,
			claimsBeforeRetry: 0,
			claimsAfterRevoke: 1,
			heldAfterDrain: 0,
			pendingAfterDrain: 0,
			pathsAfterDrain: 1,
			edgesAfterDrain: 1,
			edgesAfterSecondAlarm: 1
		});
	}, 240_000);
});

// A second consumer's verdict, written to the row while the first consumer's
// application is in flight. The owner differs from any owner a real claim
// issues, so the fence has something distinct to protect.
const replacementOwner = 'replacement-consumer';
const replacementVerdictJson = JSON.stringify({
	owner: replacementOwner,
	verdict: { kind: 'promoted' }
});

/**
 * Records one consumer's verdict and, while that verdict is being applied,
 * revokes its claim and puts a second consumer's verdict on the row. Reports
 * the row state after the first application finishes.
 *
 * The interleave runs when the application reads the shared blob row, which is
 * the first D1 read it makes. From that point the first consumer no longer owns
 * the row, so it stops and clears the verdict it read.
 */
async function driveVerdictAfterRevoke(server: string): Promise<{
	readonly page: RecordedVerdictPage;
	readonly didInterleave: boolean;
	readonly claimOwner: string | null | undefined;
	readonly recordedVerdictJson: string | null | undefined;
}> {
	const [upload] = await deferFreshUploads(server, 1, 'revoked', 300);

	if (upload === undefined) {
		throw new Error('The revoked verdict fixture staged no upload.');
	}

	return runInDurableObject(currentServer(), async (instance, state) => {
		const claim = await instance.claimVerificationBatch(
			1,
			Number.MAX_SAFE_INTEGER
		);
		const local = drizzle(state.storage, { schema: { pendingUploads } });
		let didInterleave = false;
		const interleave = (): void => {
			if (didInterleave) {
				return;
			}

			didInterleave = true;
			local
				.update(pendingUploads)
				.set({
					claimOwner: replacementOwner,
					claimedAt: isoTimestamp(new Date()),
					recordedVerdictJson: replacementVerdictJson
				})
				.where(eq(pendingUploads.id, upload.uploadId))
				.run();
		};
		const verification: unknown = Reflect.get(instance, 'verification');
		if (!(verification instanceof VerificationService)) {
			throw new TypeError('The test server has no verification service.');
		}
		const drain = vi.spyOn(verification, 'applyRecordedVerdicts');
		const real = instance.context.d1;
		const interleaving = flakyD1(env.CUPBOARD_DB, {
			failures: 0,
			matches: (query) => query.includes('blob_state'),
			onMatch: interleave
		});

		Object.defineProperty(instance.context, 'd1', {
			configurable: true,
			value: drizzleD1(boundedD1(interleaving), { schema: d1Schema })
		});

		let page: RecordedVerdictPage;
		try {
			await state.storage.deleteAlarm();
			await instance.recordVerifications(
				claim.owner,
				verifiedResults(claim.claims, [upload])
			);
			const result = drain.mock.results[0];
			if (result?.type !== 'return') {
				throw new Error('The verdict drain did not return a page.');
			}
			page = await result.value;
		} finally {
			drain.mockRestore();
			Object.defineProperty(instance.context, 'd1', {
				configurable: true,
				value: real
			});
		}

		const row = local
			.select()
			.from(pendingUploads)
			.where(eq(pendingUploads.id, upload.uploadId))
			.get();

		return {
			page,
			didInterleave,
			claimOwner: row?.claimOwner,
			recordedVerdictJson: row?.recordedVerdictJson
		};
	});
}

describe('recorded verdict fencing', () => {
	beforeEach(resetTestServer);

	it('preserves a replacement verdict and reports it as unresolved after the owner is revoked', async () => {
		const driven = await driveVerdictAfterRevoke('verify-fence-revoke');

		expect(driven).toStrictEqual({
			page: { applied: 0, resolved: 0 },
			didInterleave: true,
			claimOwner: replacementOwner,
			recordedVerdictJson: replacementVerdictJson
		});
	}, 240_000);
});

// Malformed JSON that an interrupted write could leave in a verdict row.
const malformedVerdictJson = '{"owner"';

/**
 * Claims three deferred uploads and records a verdict for each. The recording
 * applies one and leaves two on their rows; the fixture then replaces the
 * lower-numbered held verdict with text that is not JSON and runs two alarms.
 *
 * A drain pass applies one verdict, so the first alarm reaches the malformed
 * one and the second reaches the verdict behind it.
 */
async function driveMalformedVerdict(server: string): Promise<{
	readonly heldAfterRecord: number;
	readonly heldAfterFirstAlarm: number;
	readonly heldAfterSecondAlarm: number;
	readonly isMalformedVerdictCleared: boolean;
	readonly pendingAfterDrain: number;
	readonly publishedPaths: number;
}> {
	const uploads = await deferFreshUploads(server, 3, 'malformed', 500);

	return runInDurableObject(currentServer(), async (instance, state) => {
		const claim = await instance.claimVerificationBatch(
			uploads.length,
			Number.MAX_SAFE_INTEGER
		);
		const local = drizzle(state.storage, {
			schema: { narInfos, pendingUploads }
		});
		const heldRows = (): (typeof pendingUploads.$inferSelect)[] =>
			local
				.select()
				.from(pendingUploads)
				.where(isNotNull(pendingUploads.recordedVerdictJson))
				.orderBy(asc(pendingUploads.id))
				.all();

		await state.storage.deleteAlarm();
		await withDeployedSubrequestAllowance(
			instance.context,
			subrequestSafetyReserve +
				pendingSettlePrefetchSubrequests +
				subrequestsPerRecordedVerdict +
				4,
			() =>
				instance.recordVerifications(
					claim.owner,
					verifiedResults(claim.claims, uploads)
				)
		);

		const held = heldRows();
		const malformed = held[0];

		if (malformed === undefined) {
			throw new Error('The malformed verdict fixture held no verdict.');
		}

		local
			.update(pendingUploads)
			.set({ recordedVerdictJson: malformedVerdictJson })
			.where(eq(pendingUploads.id, malformed.id))
			.run();

		// Start the rotation at the first pass, so each alarm reaches the verdict
		// drain rather than resuming after it.
		await state.storage.delete(maintenancePassCursorKey);
		await state.storage.deleteAlarm();
		await instance.alarm();

		const heldAfterFirstAlarm = heldRows().length;

		await state.storage.delete(maintenancePassCursorKey);
		await state.storage.deleteAlarm();
		await instance.alarm();

		return {
			heldAfterRecord: held.length,
			heldAfterFirstAlarm,
			heldAfterSecondAlarm: heldRows().length,
			isMalformedVerdictCleared:
				local
					.select({ recordedVerdictJson: pendingUploads.recordedVerdictJson })
					.from(pendingUploads)
					.where(eq(pendingUploads.id, malformed.id))
					.get()?.recordedVerdictJson == undefined,
			pendingAfterDrain: local
				.select({ id: pendingUploads.id })
				.from(pendingUploads)
				.all().length,
			publishedPaths: local
				.select({ storePathHash: narInfos.storePathHash })
				.from(narInfos)
				.all().length
		};
	});
}

describe('unreadable recorded verdicts', () => {
	beforeEach(resetTestServer);

	it('clears a verdict it cannot read and applies the one behind it', async () => {
		const driven = await driveMalformedVerdict('verify-fence-malformed');

		// The drain cannot apply malformed JSON. It clears the value and returns the
		// row to ordinary claiming, so the malformed value cannot stop the
		// verdict behind it from being applied on the next pass.
		expect(driven).toStrictEqual({
			heldAfterRecord: 2,
			heldAfterFirstAlarm: 0,
			heldAfterSecondAlarm: 0,
			isMalformedVerdictCleared: true,
			pendingAfterDrain: 1,
			publishedPaths: 2
		});
	}, 240_000);
});
