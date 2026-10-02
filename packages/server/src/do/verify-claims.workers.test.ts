import { rootLogger } from '@cupboard/logger';
import { startCapture } from '@cupboard/logger/testing';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { type UploadId, uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	maxVerificationRpcRows,
	r2ObjectKeySchema,
	verifyClaimLeaseMs
} from '../http/http.ts';
import {
	asOneInvocation,
	commitPath,
	currentServer,
	deferFreshUpload,
	expectSingleCommitDecision,
	initialise,
	markUploadCommitting,
	markUploadPendingVerification,
	negotiateUploads,
	pendingUploadVerdict,
	resetTestServer,
	seedReservedNarInfo,
	tenantUsageRow,
	testBase,
	uploadMetadata,
	uploadStatus,
	verifiableNar,
	verifyCurrentTenant,
	withoutAlarmArming
} from '../test-support.ts';

import { type CommitPipelineService } from './commit-pipeline-service.ts';
import { RetryClockService } from './retry-clock-service.ts';
import { UploadStateService } from './upload-state-service.ts';
import {
	type PendingVerification,
	type PendingVerificationBatch,
	recordedVerdictCursorKey,
	type VerificationService
} from './verification-service.ts';

function claimOrder(
	uploads: readonly {
		uploadId: UploadId;
		r2Key: string;
		metadata: { narHash: PendingVerification['narHash']; narSize: number };
	}[]
): PendingVerification[] {
	return uploads
		.toSorted((left, right) => byCodeUnit(left.uploadId, right.uploadId))
		.map((upload) => ({
			uploadId: upload.uploadId,
			r2Key: r2ObjectKeySchema.parse(upload.r2Key),
			narHash: upload.metadata.narHash,
			narSize: upload.metadata.narSize,
			reuse: false
		}));
}

function withoutOwner(
	batch: PendingVerificationBatch
): Omit<PendingVerificationBatch, 'owner'> {
	expect(batch.owner).toMatch(
		/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u
	);

	return { claims: batch.claims, truncated: batch.truncated };
}

// A claim is a bounded chunk of the pending backlog: a row cap and a
// cumulative byte cap over the fresh rows, with `truncated` telling the
// consumer to chain another pass for what was left behind.
describe('claiming a verification batch', () => {
	beforeEach(resetTestServer);

	it.each(['suspended', 'offboarding'] as const)(
		'leaves fresh verification untouched while the tenant is %s',
		async (status) => {
			const token = await initialise();
			const upload = await deferFreshUpload(
				token,
				'inactive-fresh',
				'f'.repeat(32)
			);
			await drizzleD1(env.CUPBOARD_DB)
				.update(d1Schema.tenant)
				.set({ status })
				.run();
			const batch = await currentServer().claimVerificationBatch(
				1,
				Number.MAX_SAFE_INTEGER
			);
			const row = await runInDurableObject(currentServer(), (instance) => {
				const pending = instance.context.db
					.select({
						failures: schema.pendingUploads.settleFailures,
						started: schema.pendingUploads.retryStartedActiveMs,
						owner: schema.pendingUploads.claimOwner,
						retryAfter: schema.pendingUploads.settleRetryAfter
					})
					.from(schema.pendingUploads)
					.where(eq(schema.pendingUploads.id, upload.uploadId))
					.get();
				return pending === undefined
					? undefined
					: {
							...pending,
							started: pending.started ?? undefined,
							owner: pending.owner ?? undefined,
							retryAfter: pending.retryAfter ?? undefined
						};
			});
			expect({ batch: withoutOwner(batch), row }).toStrictEqual({
				batch: { claims: [], truncated: false },
				row: {
					failures: 0,
					started: undefined,
					owner: undefined,
					retryAfter: undefined
				}
			});
		}
	);

	it.each(['attempt-limit', 'eligible-age-limit'] as const)(
		'reclaims an uncommitted fresh reservation after %s and reports retryable absence',
		async (bound) => {
			const token = await initialise();
			const upload = await deferFreshUpload(
				token,
				'exhausted-fresh',
				'c'.repeat(32)
			);
			await seedReservedNarInfo(upload.metadata);
			const claim = await currentServer().claimVerificationBatch(
				1,
				Number.MAX_SAFE_INTEGER
			);
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db
					.update(schema.pendingUploads)
					.set({
						settleFailures: bound === 'attempt-limit' ? 11 : 0,
						retryStartedActiveMs: 0
					})
					.where(eq(schema.pendingUploads.id, upload.uploadId))
					.run();
			});
			await drizzleD1(env.CUPBOARD_DB)
				.update(d1Schema.tenant)
				.set({
					retryActiveElapsedMs: bound === 'eligible-age-limit' ? 86_400_000 : 0,
					retryActiveSinceMs: sql`null`
				})
				.run();
			await currentServer().recordVerifications(claim.owner, [
				{ uploadId: upload.uploadId, verdict: { kind: 'abandoned' } }
			]);
			const reservations = await runInDurableObject(
				currentServer(),
				(instance) =>
					instance.context.db
						.select({ hash: schema.narInfos.storePathHash })
						.from(schema.narInfos)
						.all()
			);
			expect({
				status: await uploadStatus(upload.uploadId),
				reservations,
				stagingExists: (await env.BLOBS.head(upload.r2Key)) !== null,
				usage: await tenantUsageRow()
			}).toStrictEqual({
				status: 'absent',
				reservations: [],
				stagingExists: false,
				usage: {
					bytes: 0,
					narinfos: 0,
					blobs: 0,
					casBytes: 0,
					casBlobs: 0,
					quotaBytes: undefined
				}
			});
		}
	);

	it.each([false, true])(
		'retries exhausted staging cleanup durably and preserves committed charges: %s',
		async (committed) => {
			const token = await initialise();
			const upload = await deferFreshUpload(
				token,
				'cleanup-failure',
				'd'.repeat(32)
			);
			const pending = await runInDurableObject(currentServer(), (instance) =>
				instance.context.db
					.select()
					.from(schema.pendingUploads)
					.where(eq(schema.pendingUploads.id, upload.uploadId))
					.get()
			);
			if (pending === undefined) {
				throw new Error('The fixture needs its pending upload.');
			}
			if (committed) {
				await verifyCurrentTenant();
				await env.BLOBS.put(upload.r2Key, upload.nar.narBytes);
			} else {
				await seedReservedNarInfo(upload.metadata);
			}
			const usage = await tenantUsageRow();
			const references = await drizzleD1(env.CUPBOARD_DB)
				.select()
				.from(d1Schema.blobReference)
				.all();
			const now = new Date();
			vi.useFakeTimers();
			vi.setSystemTime(now);
			const result = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const verification = (
						instance as unknown as { verification: VerificationService }
					).verification;
					instance.context.db
						.insert(schema.pendingUploads)
						.values({
							...pending,
							claimOwner: sql`null`,
							claimedAt: sql`null`,
							settleFailures: 12,
							settleExhaustion: 'attempt-limit',
							settleRetryAfter: sql`null`
						})
						.onConflictDoUpdate({
							target: schema.pendingUploads.id,
							set: {
								claimOwner: sql`null`,
								claimedAt: sql`null`,
								settleFailures: 12,
								settleExhaustion: 'attempt-limit',
								settleRetryAfter: sql`null`
							}
						})
						.run();
					const originalDelete = instance.context.env.BLOBS.delete.bind(
						instance.context.env.BLOBS
					);
					let isFailed = false;
					const deletion = vi
						.spyOn(instance.context.env.BLOBS, 'delete')
						.mockImplementation((key) => {
							if (!isFailed && key === upload.r2Key) {
								isFailed = true;
								return Promise.reject(
									new Error('https://provider.invalid/private?token=sensitive')
								);
							}
							return originalDelete(key);
						});
					try {
						const first = await asOneInvocation(() =>
							verification.processExhaustedUploads(rootLogger())
						);
						const parked = instance.context.db
							.select({
								failures: schema.pendingUploads.settleFailures,
								category: schema.pendingUploads.lastSettleError,
								retryAfter: schema.pendingUploads.settleRetryAfter,
								owner: schema.pendingUploads.claimOwner
							})
							.from(schema.pendingUploads)
							.where(eq(schema.pendingUploads.id, upload.uploadId))
							.get();
						const waiting = await asOneInvocation(() =>
							verification.processExhaustedUploads(rootLogger())
						);
						vi.setSystemTime(new Date(now.getTime() + 10 * 60_000));
						const second = await asOneInvocation(() =>
							verification.processExhaustedUploads(rootLogger())
						);
						const replay = await asOneInvocation(() =>
							verification.processExhaustedUploads(rootLogger())
						);
						return {
							first,
							parked:
								parked === undefined
									? undefined
									: { ...parked, owner: parked.owner ?? undefined },
							waiting,
							second,
							replay
						};
					} finally {
						deletion.mockRestore();
					}
				}
			);
			expect({
				result,
				status: await uploadStatus(upload.uploadId),
				stagingExists: (await env.BLOBS.head(upload.r2Key)) !== null,
				usage: await tenantUsageRow(),
				references: await drizzleD1(env.CUPBOARD_DB)
					.select()
					.from(d1Schema.blobReference)
					.all()
			}).toStrictEqual({
				result: {
					first: 0,
					parked: {
						failures: 12,
						category: 'cleanup-failed',
						retryAfter: new Date(now.getTime() + 10 * 60_000).toISOString(),
						owner: undefined
					},
					waiting: 0,
					second: 1,
					replay: 0
				},
				status: 'absent',
				stagingExists: false,
				usage,
				references
			});
		}
	);

	it.each([
		{ method: 'prepareRecordedVerdict', category: 'prepare-failed' },
		{ method: 'materialiseVerified', category: 'materialisation-failed' }
	] as const)(
		'backs off a recorded verdict after $category and preserves its decode result',
		async ({ method, category }) => {
			await withoutAlarmArming(async () => {
				const token = await initialise();
				const upload = await deferFreshUpload(
					token,
					'recorded-failure',
					'b'.repeat(32)
				);
				const claim = await currentServer().claimVerificationBatch(
					1,
					Number.MAX_SAFE_INTEGER
				);
				const now = Date.now();
				const verified = {
					ok: true as const,
					fileHash: upload.metadata.fileHash,
					fileSize: upload.metadata.fileSize
				};
				const result = await runInDurableObject(
					currentServer(),
					async (instance) => {
						const verification = (
							instance as unknown as { verification: VerificationService }
						).verification;
						const target = verification as unknown as {
							prepareRecordedVerdict: () => Promise<unknown>;
							materialiseVerified: () => Promise<unknown>;
						};
						const fault = vi
							.spyOn(target, method)
							.mockRejectedValue(
								new Error('provider failed at https://secret.example/token')
							);

						try {
							const first = await asOneInvocation(() =>
								verification.recordVerifications(rootLogger(), claim.owner, [
									{
										uploadId: upload.uploadId,
										verdict: { kind: 'verified', verification: verified }
									}
								])
							);
							const second = await asOneInvocation(() =>
								verification.applyRecordedVerdicts(rootLogger())
							);
							const row = instance.context.db
								.select({
									failures: schema.pendingUploads.settleFailures,
									retryAfter: schema.pendingUploads.settleRetryAfter,
									category: schema.pendingUploads.lastSettleError,
									recorded: schema.pendingUploads.recordedVerdictJson
								})
								.from(schema.pendingUploads)
								.where(eq(schema.pendingUploads.id, upload.uploadId))
								.get();

							return { first, second, attempts: fault.mock.calls.length, row };
						} finally {
							fault.mockRestore();
						}
					}
				);

				expect(result).toStrictEqual({
					first: 0,
					second: { applied: 0, resolved: 0 },
					attempts: 1,
					row: {
						failures: 1,
						retryAfter: new Date(now + 30_000).toISOString(),
						category,
						recorded: JSON.stringify({
							owner: claim.owner,
							verdict: { kind: 'verified', verification: verified }
						})
					}
				});
			});
		}
	);

	it.each([false, true])(
		'backs off a fresh decode failure without allowing client re-drive to reset it: %s',
		async (isRedriven) => {
			const token = await initialise();
			const upload = await deferFreshUpload(
				token,
				'fresh-decode-backoff',
				'a'.repeat(32)
			);
			const claim = await currentServer().claimVerificationBatch(
				1,
				Number.MAX_SAFE_INTEGER
			);
			const now = new Date();
			vi.useFakeTimers();
			vi.setSystemTime(now);

			try {
				const applied = await currentServer().recordVerifications(claim.owner, [
					{ uploadId: upload.uploadId, verdict: { kind: 'abandoned' } }
				]);
				const state = await runInDurableObject(currentServer(), (instance) => {
					if (isRedriven) {
						new UploadStateService(instance.context).markUploadPending(
							upload.uploadId
						);
					}

					const row = instance.context.db
						.select({
							failures: schema.pendingUploads.settleFailures,
							retryAfter: schema.pendingUploads.settleRetryAfter,
							category: schema.pendingUploads.lastSettleError,
							verdict: schema.pendingUploads.verdict,
							owner: schema.pendingUploads.claimOwner
						})
						.from(schema.pendingUploads)
						.where(eq(schema.pendingUploads.id, upload.uploadId))
						.get();

					return row === undefined
						? undefined
						: { ...row, owner: row.owner ?? undefined };
				});
				const retry = await currentServer().claimVerificationBatch(
					1,
					Number.MAX_SAFE_INTEGER
				);

				expect({ applied, state, retry: withoutOwner(retry) }).toStrictEqual({
					applied: 0,
					state: {
						failures: 1,
						retryAfter: new Date(now.getTime() + 30_000).toISOString(),
						category: 'verification-failed',
						verdict: 'pending',
						owner: undefined
					},
					retry: { claims: [], truncated: false }
				});
			} finally {
				vi.useRealTimers();
			}
		}
	);

	it.each([0, -1, 1.5, NaN, Infinity, 2 ** 53])(
		'rejects the invalid row limit %s',
		async (limit) => {
			await expect(
				runInDurableObject(currentServer(), (instance) =>
					instance.claimVerificationBatch(limit, 1)
				)
			).rejects.toThrow();
		}
	);

	it('accepts the shared claim limit and rejects the next row', async () => {
		await expect(
			currentServer().claimVerificationBatch(
				maxVerificationRpcRows,
				Number.MAX_SAFE_INTEGER
			)
		).resolves.toMatchObject({ claims: [] });
		await expect(
			runInDurableObject(currentServer(), (instance) =>
				instance.claimVerificationBatch(
					maxVerificationRpcRows + 1,
					Number.MAX_SAFE_INTEGER
				)
			)
		).rejects.toThrow();
		await expect(
			runInDurableObject(currentServer(), (instance) =>
				instance.claimPendingVerifications(maxVerificationRpcRows)
			)
		).resolves.toStrictEqual([]);
		await expect(
			runInDurableObject(currentServer(), (instance) =>
				instance.claimPendingVerifications(maxVerificationRpcRows + 1)
			)
		).rejects.toThrow();
	});

	it('bounds lease renewal before constructing the SQLite predicate', async () => {
		const uploadIds = Array.from(
			{ length: maxVerificationRpcRows },
			(_, index) => `not-a-live-upload-${String(index)}` as UploadId
		);

		await expect(
			currentServer().renewVerificationClaims('owner', uploadIds)
		).resolves.toBe(false);
		await expect(
			runInDurableObject(currentServer(), (instance) =>
				instance.renewVerificationClaims('owner', [
					...uploadIds,
					'not-a-live-upload-over-limit' as UploadId
				])
			)
		).rejects.toThrow(
			`A verification renewal may contain at most ${String(maxVerificationRpcRows)} upload IDs.`
		);
	});

	it('defers ownerless legacy verdict RPCs to a current pass', async () => {
		const uploadId = 'not-a-live-upload' as UploadId;

		await expect(
			runInDurableObject(currentServer(), (instance) =>
				instance.recordVerification(uploadId, { ok: true })
			)
		).resolves.toBeUndefined();
		await expect(
			runInDurableObject(currentServer(), (instance) =>
				instance.recordMissingObject(uploadId)
			)
		).resolves.toBeUndefined();
		await expect(
			runInDurableObject(currentServer(), (instance) =>
				instance.recordVerifications([
					{ uploadId, verdict: { kind: 'abandoned' } }
				])
			)
		).resolves.toBe(0);
	});

	it('bounds the verdict array before applying its entries', async () => {
		const result = {
			uploadId: 'not-a-live-upload' as UploadId,
			verdict: { kind: 'abandoned' as const }
		};

		await expect(
			currentServer().recordVerifications(
				'owner',
				Array.from({ length: maxVerificationRpcRows }, () => result)
			)
		).resolves.toBe(0);
		await expect(
			runInDurableObject(currentServer(), (instance) =>
				instance.recordVerifications(
					'owner',
					Array.from({ length: maxVerificationRpcRows + 1 }, () => result)
				)
			)
		).rejects.toThrow(
			`A verification result batch may contain at most ${String(maxVerificationRpcRows)} entries.`
		);
	});

	it.each([0, -1, 1.5, NaN, Infinity, 2 ** 53])(
		'rejects the invalid byte cap %s',
		async (maxNarBytes) => {
			await expect(
				runInDurableObject(currentServer(), (instance) =>
					instance.claimVerificationBatch(1, maxNarBytes)
				)
			).rejects.toThrow();
		}
	);

	it('cuts the claim at the byte cap and reports the truncation', async () => {
		const token = await initialise();
		const uploads = [
			await deferFreshUpload(token, 'byte-cap-a', 'a'.repeat(32)),
			await deferFreshUpload(token, 'byte-cap-b', 'b'.repeat(32)),
			await deferFreshUpload(token, 'byte-cap-c', 'c'.repeat(32))
		];
		const ordered = claimOrder(uploads);
		const capForTwo = ordered
			.slice(0, 2)
			.reduce((total, claim) => total + claim.narSize, 0);

		const batch = await currentServer().claimVerificationBatch(10, capForTwo);

		expect(withoutOwner(batch)).toStrictEqual({
			claims: ordered.slice(0, 2),
			truncated: true
		});
	});

	it('claims a lone over-cap row rather than starving it', async () => {
		const token = await initialise();
		const uploads = [
			await deferFreshUpload(token, 'over-cap-a', 'a'.repeat(32)),
			await deferFreshUpload(token, 'over-cap-b', 'b'.repeat(32))
		];
		const ordered = claimOrder(uploads);

		const batch = await currentServer().claimVerificationBatch(10, 1);

		expect(withoutOwner(batch)).toStrictEqual({
			claims: ordered.slice(0, 1),
			truncated: true
		});
	});

	it('cuts the claim at the row cap', async () => {
		const token = await initialise();
		const uploads = [
			await deferFreshUpload(token, 'row-cap-a', 'a'.repeat(32)),
			await deferFreshUpload(token, 'row-cap-b', 'b'.repeat(32)),
			await deferFreshUpload(token, 'row-cap-c', 'c'.repeat(32))
		];
		const ordered = claimOrder(uploads);

		const batch = await currentServer().claimVerificationBatch(
			2,
			Number.MAX_SAFE_INTEGER
		);

		expect(withoutOwner(batch)).toStrictEqual({
			claims: ordered.slice(0, 2),
			truncated: true
		});
	});

	it('leases its claims against an overlapping pass', async () => {
		const token = await initialise();
		const uploads = [
			await deferFreshUpload(token, 'lease-a', 'a'.repeat(32)),
			await deferFreshUpload(token, 'lease-b', 'b'.repeat(32))
		];
		const ordered = claimOrder(uploads);

		const first = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);
		const duplicate = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);

		expect({
			first: withoutOwner(first),
			duplicate: withoutOwner(duplicate)
		}).toStrictEqual({
			first: {
				claims: ordered,
				truncated: false
			},
			duplicate: {
				claims: [],
				truncated: false
			}
		});
	});

	it("frees a crashed pass's claims once the lease expires", async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(
			token,
			'lease-expiry',
			'a'.repeat(32)
		);
		const ordered = claimOrder([upload]);

		vi.useFakeTimers();

		try {
			vi.setSystemTime(testBase);

			const first = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			vi.setSystemTime(new Date(testBase.getTime() + verifyClaimLeaseMs - 1));

			const fresh = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			vi.setSystemTime(new Date(testBase.getTime() + verifyClaimLeaseMs));

			const expired = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			expect({
				first: withoutOwner(first),
				fresh: withoutOwner(fresh),
				expired: withoutOwner(expired)
			}).toStrictEqual({
				first: {
					claims: ordered,
					truncated: false
				},
				fresh: {
					claims: [],
					truncated: false
				},
				expired: {
					claims: ordered,
					truncated: false
				}
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps a renewed claim leased for a full interval from renewal', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(
			token,
			'lease-renewal',
			'a'.repeat(32)
		);
		const ordered = claimOrder([upload]);

		vi.useFakeTimers();

		try {
			vi.setSystemTime(testBase);
			const first = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			vi.setSystemTime(
				new Date(testBase.getTime() + Math.floor(verifyClaimLeaseMs / 2))
			);
			await currentServer().renewVerificationClaims(first.owner, [
				upload.uploadId
			]);

			vi.setSystemTime(new Date(testBase.getTime() + verifyClaimLeaseMs));
			const stillLeased = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			vi.setSystemTime(
				new Date(
					testBase.getTime() +
						verifyClaimLeaseMs +
						Math.floor(verifyClaimLeaseMs / 2)
				)
			);
			const expired = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			expect({
				first: withoutOwner(first),
				stillLeased: withoutOwner(stillLeased),
				expired: withoutOwner(expired)
			}).toStrictEqual({
				first: {
					claims: ordered,
					truncated: false
				},
				stillLeased: {
					claims: [],
					truncated: false
				},
				expired: {
					claims: ordered,
					truncated: false
				}
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('renews every row while some claims remain queued', async () => {
		const token = await initialise();
		const uploads = [
			await deferFreshUpload(token, 'lease-parked-a', 'a'.repeat(32)),
			await deferFreshUpload(token, 'lease-parked-b', 'b'.repeat(32)),
			await deferFreshUpload(token, 'lease-parked-c', 'c'.repeat(32))
		];

		vi.useFakeTimers();

		try {
			vi.setSystemTime(testBase);
			const batch = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);
			const uploadIds = batch.claims.map((claim) => claim.uploadId);

			vi.setSystemTime(
				new Date(testBase.getTime() + Math.floor(verifyClaimLeaseMs / 2))
			);
			await currentServer().renewVerificationClaims(batch.owner, uploadIds);

			vi.setSystemTime(new Date(testBase.getTime() + verifyClaimLeaseMs));
			const overlapping = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			expect({
				uploadIds,
				overlapping: withoutOwner(overlapping)
			}).toStrictEqual({
				uploadIds: claimOrder(uploads).map((claim) => claim.uploadId),
				overlapping: {
					claims: [],
					truncated: false
				}
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects renewal and verdicts from an expired claim owner', async () => {
		const token = await initialise();
		const uploads = [
			await deferFreshUpload(token, 'lease-owner-a', 'a'.repeat(32)),
			await deferFreshUpload(token, 'lease-owner-b', 'b'.repeat(32))
		];

		vi.useFakeTimers();

		try {
			vi.setSystemTime(testBase);
			const expired = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);
			const uploadIds = expired.claims.map((claim) => claim.uploadId);

			vi.setSystemTime(new Date(testBase.getTime() + verifyClaimLeaseMs));
			const replacement = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);
			const [firstUploadId, secondUploadId] = uploadIds;

			if (firstUploadId === undefined || secondUploadId === undefined) {
				throw new Error('Expected two claimed uploads.');
			}

			await expect(
				currentServer().renewVerificationClaims(expired.owner, uploadIds)
			).resolves.toBe(false);
			const applied = await currentServer().recordVerifications(expired.owner, [
				{ uploadId: firstUploadId, verdict: { kind: 'abandoned' } },
				{ uploadId: secondUploadId, verdict: { kind: 'missing' } }
			]);
			await currentServer().renewVerificationClaims(
				replacement.owner,
				uploadIds
			);
			const overlapping = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			expect({
				applied,
				overlapping: withoutOwner(overlapping),
				verdicts: await Promise.all(
					uploads.map((upload) => pendingUploadVerdict(upload.uploadId))
				)
			}).toStrictEqual({
				applied: 0,
				overlapping: {
					claims: [],
					truncated: false
				},
				verdicts: ['pending', 'pending']
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('leases only the rows the claim returned', async () => {
		const token = await initialise();
		const uploads = [
			await deferFreshUpload(token, 'scope-a', 'a'.repeat(32)),
			await deferFreshUpload(token, 'scope-b', 'b'.repeat(32)),
			await deferFreshUpload(token, 'scope-c', 'c'.repeat(32))
		];
		const ordered = claimOrder(uploads);
		const capForTwo = ordered
			.slice(0, 2)
			.reduce((total, claim) => total + claim.narSize, 0);

		const first = await currentServer().claimVerificationBatch(10, capForTwo);
		const rest = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);

		expect({
			first: withoutOwner(first),
			rest: withoutOwner(rest)
		}).toStrictEqual({
			first: {
				claims: ordered.slice(0, 2),
				truncated: true
			},
			rest: {
				claims: ordered.slice(2),
				truncated: false
			}
		});
	});

	it('keeps the cron pass off leased rows', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(token, 'cron-lease', 'a'.repeat(32));

		await currentServer().claimVerificationBatch(10, Number.MAX_SAFE_INTEGER);
		await verifyCurrentTenant();

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('pending');
	});

	it.each(['pending', 'committing'] as const)(
		'revokes the old claim when a client marks the upload %s',
		async (verdict) => {
			const token = await initialise();
			const upload = await deferFreshUpload(
				token,
				`redrive-${verdict}`,
				'a'.repeat(32)
			);

			const oldClaim = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			await runInDurableObject(currentServer(), (instance) => {
				const uploadState = new UploadStateService(instance.context);

				if (verdict === 'pending') {
					uploadState.markUploadPending(upload.uploadId);
					return;
				}

				uploadState.markUploadCommitting(upload.uploadId);
			});

			const wasRenewed = await currentServer().renewVerificationClaims(
				oldClaim.owner,
				[upload.uploadId]
			);
			const applied = await currentServer().recordVerifications(
				oldClaim.owner,
				[{ uploadId: upload.uploadId, verdict: { kind: 'missing' } }]
			);
			const reclaimed = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			expect({
				wasRenewed,
				applied,
				verdict: await pendingUploadVerdict(upload.uploadId),
				reclaimed: withoutOwner(reclaimed)
			}).toStrictEqual({
				wasRenewed: false,
				applied: 0,
				verdict,
				reclaimed: {
					claims: claimOrder([upload]),
					truncated: false
				}
			});
		}
	);

	it('settles reuse rows before returning decode claims', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reuse-free');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		const reuses = [];

		for (const storePathHash of ['b'.repeat(32), 'c'.repeat(32)]) {
			const metadata = uploadMetadata({
				name: `reuse-${storePathHash.slice(0, 1)}`,
				storePathHash,
				narHash: nar.narHash,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength,
				narSize: nar.narSize
			});
			const decision = expectSingleCommitDecision(
				await negotiateUploads(token, [metadata]),
				metadata
			);

			await markUploadPendingVerification(decision.uploadId);
			reuses.push({ uploadId: decision.uploadId });
		}

		const batch = await currentServer().claimVerificationBatch(10, 1);

		expect({
			batch: withoutOwner(batch),
			verdicts: await Promise.all(
				reuses.map((reuse) => pendingUploadVerdict(reuse.uploadId))
			)
		}).toStrictEqual({
			batch: { claims: [], truncated: false },
			verdicts: [undefined, undefined]
		});
	});

	it('settles reuse rows beyond a full prefix of committing fresh work', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reuse-after-fresh-prefix');
		const first = uploadMetadata({
			name: 'canonical',
			storePathHash: 'c'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		await commitPath(token, first, nar);
		const fresh = [
			await deferFreshUpload(token, 'fresh-prefix-a', 'a'.repeat(32)),
			await deferFreshUpload(token, 'fresh-prefix-b', 'b'.repeat(32))
		];
		await Promise.all(
			fresh.flatMap((upload) => [
				markUploadCommitting(upload.uploadId),
				seedReservedNarInfo(upload.metadata)
			])
		);
		const reuseMetadata = uploadMetadata({
			name: 'reuse',
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

		const orderedIds = [
			uploadIdSchema.parse('a-fresh'),
			uploadIdSchema.parse('b-fresh'),
			uploadIdSchema.parse('z-reuse')
		];
		const reuseId = orderedIds[2];

		if (reuseId === undefined) {
			throw new Error('expected the reuse upload ID fixture');
		}
		await runInDurableObject(currentServer(), (instance) => {
			for (const [from, to] of [
				[fresh[0]?.uploadId, orderedIds[0]],
				[fresh[1]?.uploadId, orderedIds[1]],
				[reuse.uploadId, orderedIds[2]]
			] as const) {
				if (from === undefined || to === undefined) {
					throw new Error('expected every pending upload fixture');
				}

				instance.context.db
					.update(schema.pendingUploads)
					.set({ id: to })
					.where(eq(schema.pendingUploads.id, from))
					.run();
			}
		});

		const batch = await currentServer().claimVerificationBatch(
			2,
			Number.MAX_SAFE_INTEGER
		);
		const reuseRow = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({ id: schema.pendingUploads.id })
				.from(schema.pendingUploads)
				.where(eq(schema.pendingUploads.id, reuseId))
				.get()
		);

		expect({
			claims: batch.claims.map((claim) => claim.uploadId),
			reuseRow
		}).toStrictEqual({
			claims: orderedIds.slice(0, 2),
			reuseRow: undefined
		});
	});

	it.each(['absent', 'legacy'] as const)(
		'continues recovery in readiness order when the cursor is %s',
		async (cursorKind) => {
			await withoutAlarmArming(async () => {
				const token = await initialise();
				const later = await deferFreshUpload(
					token,
					'later-ready',
					'a'.repeat(32)
				);
				const earlier = await deferFreshUpload(
					token,
					'earlier-ready',
					'b'.repeat(32)
				);
				await Promise.all(
					[later, earlier].flatMap((upload) => [
						markUploadCommitting(upload.uploadId),
						seedReservedNarInfo(upload.metadata)
					])
				);
				const laterId = uploadIdSchema.parse('a-later-ready');
				const earlierId = uploadIdSchema.parse('z-earlier-ready');
				const laterReadyAt = isoTimestampSchema.parse(
					'2025-12-31T23:59:59.000Z'
				);
				const measured = await runInDurableObject(
					currentServer(),
					async (instance) => {
						instance.context.db
							.update(schema.pendingUploads)
							.set({ id: laterId, settleRetryAfter: laterReadyAt })
							.where(eq(schema.pendingUploads.id, later.uploadId))
							.run();
						instance.context.db
							.update(schema.pendingUploads)
							.set({ id: earlierId })
							.where(eq(schema.pendingUploads.id, earlier.uploadId))
							.run();
						const cursorKey = 'maintenance:verification-decode-free-cursor';
						await instance.context.ctx.storage.delete(cursorKey);
						if (cursorKind === 'legacy') {
							await instance.context.ctx.storage.put(cursorKey, {
								next: 'recovery',
								recovery: earlierId
							});
						}
						const verification = (
							instance as unknown as { verification: VerificationService }
						).verification;
						const pipeline = (
							verification as unknown as {
								commitPipeline: CommitPipelineService;
							}
						).commitPipeline;
						const probe = vi
							.spyOn(pipeline, 'isGenerationCommitted')
							.mockResolvedValue(false);
						try {
							const passes = [];
							for (let pass = 0; pass < 3; pass++) {
								probe.mockClear();
								await asOneInvocation(() =>
									verification.processPendingWithoutDecode(rootLogger(), 1)
								);
								passes.push(
									probe.mock.calls.map(([, metadata]) => metadata.storePathHash)
								);
							}
							const failures = instance.context.db
								.select({
									id: schema.pendingUploads.id,
									count: schema.pendingUploads.settleFailures
								})
								.from(schema.pendingUploads)
								.orderBy(schema.pendingUploads.id)
								.all();
							return { passes, failures };
						} finally {
							probe.mockRestore();
						}
					}
				);
				expect(measured).toStrictEqual({
					passes: [['b'.repeat(32)], ['a'.repeat(32)], ['b'.repeat(32)]],
					failures: [
						{ id: laterId, count: 0 },
						{ id: earlierId, count: 0 }
					]
				});
			});
		}
	);

	it('advances recovery discovery past uncommitted reservations', async () => {
		const token = await initialise();
		const fresh = await Promise.all(
			['a', 'b', 'c'].map((suffix) =>
				deferFreshUpload(token, `recovery-cursor-${suffix}`, suffix.repeat(32))
			)
		);
		await Promise.all(
			fresh.flatMap((upload) => [
				markUploadCommitting(upload.uploadId),
				seedReservedNarInfo(upload.metadata)
			])
		);
		const ordered = fresh.toSorted((left, right) =>
			byCodeUnit(left.uploadId, right.uploadId)
		);

		await runInDurableObject(currentServer(), async (instance) => {
			const verification = (
				instance as unknown as { verification: VerificationService }
			).verification;
			const pipeline = (
				verification as unknown as {
					commitPipeline: CommitPipelineService;
				}
			).commitPipeline;
			const committedProbe = vi
				.spyOn(pipeline, 'isGenerationCommitted')
				.mockResolvedValue(false);

			try {
				await asOneInvocation(() =>
					verification.processPendingWithoutDecode(rootLogger(), 2)
				);
				const first = committedProbe.mock.calls.map(
					([, metadata]) => metadata.storePathHash
				);
				committedProbe.mockClear();

				await asOneInvocation(() =>
					verification.processPendingWithoutDecode(rootLogger(), 2)
				);
				const second = committedProbe.mock.calls.map(
					([, metadata]) => metadata.storePathHash
				);
				const failures = instance.context.db
					.select({
						id: schema.pendingUploads.id,
						count: schema.pendingUploads.settleFailures
					})
					.from(schema.pendingUploads)
					.orderBy(schema.pendingUploads.id)
					.all();

				expect({ first, second, failures }).toStrictEqual({
					first: ordered
						.slice(0, 2)
						.map((upload) => upload.metadata.storePathHash),
					second: ordered
						.slice(2)
						.map((upload) => upload.metadata.storePathHash),
					failures: ordered
						.map((upload) => ({ id: upload.uploadId, count: 0 }))
						.toSorted((left, right) => byCodeUnit(left.id, right.id))
				});
			} finally {
				committedProbe.mockRestore();
			}
		});
	});

	it('advances past a full page of faulting reuse rows', async () => {
		const token = await initialise();
		const recovery = await deferFreshUpload(
			token,
			'committed-recovery-after-reuse',
			'd'.repeat(32)
		);
		const recoveryRow = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select()
				.from(schema.pendingUploads)
				.where(eq(schema.pendingUploads.id, recovery.uploadId))
				.get()
		);

		if (recoveryRow === undefined) {
			throw new Error('expected the pending recovery fixture');
		}

		await verifyCurrentTenant();

		const faultingSources: {
			index: number;
			nar: Awaited<ReturnType<typeof verifiableNar>>;
		}[] = [];

		for (const [index, storePathHash] of ['a', 'b'].entries()) {
			const nar = await verifiableNar(`faulting-reuse-${String(index)}`);
			const canonical = uploadMetadata({
				name: `canonical-${String(index)}`,
				storePathHash: storePathHash.repeat(32),
				narHash: nar.narHash,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength,
				narSize: nar.narSize
			});
			await commitPath(token, canonical, nar);
			faultingSources.push({ index, nar });
		}

		const laterNar = await verifiableNar('later-reuse');
		const laterCanonical = uploadMetadata({
			name: 'later-canonical',
			storePathHash: 'c'.repeat(32),
			narHash: laterNar.narHash,
			fileHash: laterNar.fileHash,
			fileSize: laterNar.narBytes.byteLength,
			narSize: laterNar.narSize
		});
		await commitPath(token, laterCanonical, laterNar);

		const faulting: { uploadId: UploadId; narHash: NixSha256HashString }[] = [];

		for (const { index, nar } of faultingSources) {
			const reuseMetadata = uploadMetadata({
				name: `faulting-reuse-${String(index)}`,
				storePathHash: String(index + 5).repeat(32),
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
			faulting.push({
				uploadId: reuse.uploadId,
				narHash: nar.narHash
			});
		}

		const laterMetadata = uploadMetadata({
			name: 'later-reuse',
			storePathHash: '7'.repeat(32),
			narHash: laterNar.narHash,
			fileHash: laterNar.fileHash,
			fileSize: laterNar.narBytes.byteLength,
			narSize: laterNar.narSize
		});
		const laterReuse = expectSingleCommitDecision(
			await negotiateUploads(token, [laterMetadata]),
			laterMetadata
		);
		await markUploadPendingVerification(laterReuse.uploadId);

		await runInDurableObject(currentServer(), async (instance) => {
			await instance.context.ctx.storage.delete(
				'maintenance:verification-decode-free-cursor'
			);

			instance.context.db
				.insert(schema.pendingUploads)
				.values({
					...recoveryRow,
					verdict: 'committing',
					claimedAt: undefined,
					claimOwner: undefined
				})
				.run();

			for (const [from, to] of [
				[faulting[0]?.uploadId, uploadIdSchema.parse('a-faulting-reuse')],
				[faulting[1]?.uploadId, uploadIdSchema.parse('b-faulting-reuse')],
				[laterReuse.uploadId, uploadIdSchema.parse('y-later-reuse')],
				[recovery.uploadId, uploadIdSchema.parse('z-committed-recovery')]
			] as const) {
				if (from === undefined) {
					throw new Error('expected every pending upload fixture');
				}

				instance.context.db
					.update(schema.pendingUploads)
					.set({ id: to })
					.where(eq(schema.pendingUploads.id, from))
					.run();
			}
		});

		const faultingNarHashes = new Set(faulting.map((reuse) => reuse.narHash));
		const processPasses = async (): Promise<{
			readonly firstPass: {
				readonly rows: readonly { readonly id: UploadId }[];
				readonly probed: readonly NixSha256HashString[];
			};
			readonly secondPass: readonly { readonly id: UploadId }[];
			readonly warnings: readonly Readonly<Record<string, unknown>>[];
		}> => {
			const capture = startCapture();

			try {
				const firstPass = await runInDurableObject(
					currentServer(),
					async (instance) => {
						const verification = (
							instance as unknown as { verification: VerificationService }
						).verification;
						const probeTarget = verification as unknown as {
							isCurrentNarPresent: (
								narHash: NixSha256HashString
							) => Promise<boolean>;
						};
						const currentProbe =
							probeTarget.isCurrentNarPresent.bind(verification);
						const probe = vi
							.spyOn(probeTarget, 'isCurrentNarPresent')
							.mockImplementation((narHash) =>
								faultingNarHashes.has(narHash)
									? Promise.reject(new Error('sensitive reuse provider error'))
									: currentProbe(narHash)
							);

						try {
							await asOneInvocation(() =>
								verification.processPendingWithoutDecode(rootLogger(), 2)
							);
							const firstRows = instance.context.db
								.select({ id: schema.pendingUploads.id })
								.from(schema.pendingUploads)
								.orderBy(schema.pendingUploads.id)
								.all();
							const probed = probe.mock.calls.map(([narHash]) => narHash);

							await asOneInvocation(() =>
								verification.processPendingWithoutDecode(rootLogger(), 2)
							);
							const secondRows = instance.context.db
								.select({ id: schema.pendingUploads.id })
								.from(schema.pendingUploads)
								.orderBy(schema.pendingUploads.id)
								.all();

							await asOneInvocation(() =>
								verification.processPendingWithoutDecode(rootLogger(), 2)
							);

							return {
								firstPass: { rows: firstRows, probed },
								secondPass: secondRows
							};
						} finally {
							probe.mockRestore();
						}
					}
				);
				const warnings = capture.logs
					.filter(
						(record) => record.message === 'pending upload verification failed'
					)
					.map((record) => record.properties);

				return { ...firstPass, warnings };
			} finally {
				capture.stop();
			}
		};
		const { firstPass, secondPass, warnings } = await processPasses();

		const remaining = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({ id: schema.pendingUploads.id })
				.from(schema.pendingUploads)
				.orderBy(schema.pendingUploads.id)
				.all()
		);

		expect({ firstPass, secondPass, remaining, warnings }).toStrictEqual({
			firstPass: {
				rows: [
					{ id: uploadIdSchema.parse('a-faulting-reuse') },
					{ id: uploadIdSchema.parse('b-faulting-reuse') },
					{ id: uploadIdSchema.parse('y-later-reuse') },
					{ id: uploadIdSchema.parse('z-committed-recovery') }
				],
				probed: faulting.map((reuse) => reuse.narHash)
			},
			secondPass: [
				{ id: uploadIdSchema.parse('a-faulting-reuse') },
				{ id: uploadIdSchema.parse('b-faulting-reuse') },
				{ id: uploadIdSchema.parse('y-later-reuse') }
			],
			remaining: [
				{ id: uploadIdSchema.parse('a-faulting-reuse') },
				{ id: uploadIdSchema.parse('b-faulting-reuse') }
			],
			warnings: [
				{
					uploadId: uploadIdSchema.parse('a-faulting-reuse'),
					kind: 'reuse',
					reason: 'prepare-failed',
					failures: 1
				},
				{
					uploadId: uploadIdSchema.parse('b-faulting-reuse'),
					kind: 'reuse',
					reason: 'prepare-failed',
					failures: 1
				}
			]
		});
	});

	it('logs controlled context when a recovery probe fails', async () => {
		const token = await initialise();
		const fresh = await deferFreshUpload(
			token,
			'recovery-probe-telemetry',
			'a'.repeat(32)
		);
		await Promise.all([
			markUploadCommitting(fresh.uploadId),
			seedReservedNarInfo(fresh.metadata)
		]);
		const capture = startCapture();

		try {
			await runInDurableObject(currentServer(), async (instance) => {
				const verification = (
					instance as unknown as { verification: VerificationService }
				).verification;
				const pipeline = (
					verification as unknown as {
						commitPipeline: CommitPipelineService;
					}
				).commitPipeline;
				const committedProbe = vi
					.spyOn(pipeline, 'isGenerationCommitted')
					.mockRejectedValue(
						new Error(`sensitive-provider-error:${fresh.uploadId}`)
					);

				try {
					await asOneInvocation(() =>
						verification.processPendingWithoutDecode(rootLogger(), 1)
					);
				} finally {
					committedProbe.mockRestore();
				}
			});
		} finally {
			capture.stop();
		}

		const warnings = capture.logs
			.filter(
				(record) => record.message === 'pending upload verification failed'
			)
			.map((record) => ({
				level: record.level,
				properties: record.properties
			}));

		expect(warnings).toStrictEqual([
			{
				level: 'warning',
				properties: {
					uploadId: fresh.uploadId,
					kind: 'committed-recovery',
					reason: 'commit-state-probe-failed',
					failures: 1
				}
			}
		]);
	});
});

it.each([false, true])(
	'reads held verdicts at bounded cost with a sparse due row: %s',
	async (hasDue) => {
		await resetTestServer();
		await withoutAlarmArming(async () => {
			const token = await initialise();
			const upload = await deferFreshUpload(token, 'held-cost', 'f'.repeat(32));
			const measured = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const template = instance.context.db
						.select()
						.from(schema.pendingUploads)
						.where(eq(schema.pendingUploads.id, upload.uploadId))
						.get();
					if (template === undefined) {
						throw new Error('The fixture requires its admitted upload.');
					}
					instance.context.db.delete(schema.pendingUploads).run();
					const verification = (
						instance as unknown as { verification: VerificationService }
					).verification;
					const seed = (start: number, count: number): void => {
						for (let index = start; index < start + count; index += 1) {
							instance.context.db
								.insert(schema.pendingUploads)
								.values({
									...template,
									id: uploadIdSchema.parse(
										`held-${String(index).padStart(8, '0')}`
									),
									settleRetryAfter: isoTimestampSchema.parse(
										'2999-01-01T00:00:00.000Z'
									),
									recordedVerdictJson: JSON.stringify({
										owner: 'held-owner',
										verdict: { kind: 'missing' }
									}),
									claimOwner: 'held-owner'
								})
								.run();
						}
					};
					const measure = async () => {
						await instance.context.ctx.storage.delete(recordedVerdictCursorKey);
						if (hasDue) {
							instance.context.db
								.delete(schema.pendingUploads)
								.where(
									eq(schema.pendingUploads.id, uploadIdSchema.parse('held-due'))
								)
								.run();
							instance.context.db
								.insert(schema.pendingUploads)
								.values({
									...template,
									id: uploadIdSchema.parse('held-due'),
									settleRetryAfter: sql`null`,
									recordedVerdictJson: JSON.stringify({
										owner: 'held-owner',
										verdict: { kind: 'missing' }
									}),
									claimOwner: 'held-owner'
								})
								.run();
						}
						await new RetryClockService(instance.context).read();
						instance.context.dbCost.recordOutstanding();
						const before = instance.context.dbCost.rowsRead;
						const result =
							await verification.applyRecordedVerdicts(rootLogger());
						instance.context.dbCost.recordOutstanding();
						return {
							result,
							rowsRead: instance.context.dbCost.rowsRead - before
						};
					};
					seed(0, 3);
					const small = await measure();
					seed(3, 197);
					const large = await measure();
					return { small, large };
				}
			);
			const expected = {
				result: { applied: hasDue ? 1 : 0, resolved: hasDue ? 1 : 0 },
				rowsRead: hasDue ? 14 : 1
			};
			expect(measured).toStrictEqual({ small: expected, large: expected });
		});
	}
);

it.each(
	[false, true].flatMap((hasDue) =>
		[false, true].map((hasOwnerlessVerdict) => ({
			hasDue,
			hasOwnerlessVerdict
		}))
	)
)(
	'selects fresh and decode-free work at bounded cost with due=$hasDue and ownerless verdict=$hasOwnerlessVerdict',
	async ({ hasDue, hasOwnerlessVerdict }) => {
		await resetTestServer();
		await withoutAlarmArming(async () => {
			const token = await initialise();
			const upload = await deferFreshUpload(
				token,
				'claim-cost',
				'f'.repeat(32)
			);
			await seedReservedNarInfo(upload.metadata);
			const dueId = uploadIdSchema.parse('z-claim-due');
			const measured = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const template = instance.context.db
						.select()
						.from(schema.pendingUploads)
						.where(eq(schema.pendingUploads.id, upload.uploadId))
						.get();
					if (template === undefined) {
						throw new Error('The fixture requires its admitted upload.');
					}
					instance.context.db.delete(schema.pendingUploads).run();
					const verification = (
						instance as unknown as { verification: VerificationService }
					).verification;
					const pending = {
						...template,
						claimOwner: sql`null`,
						claimedAt: sql`null`,
						recordedVerdictJson: hasOwnerlessVerdict
							? 'invalid-verdict'
							: sql`null`
					};
					const seed = (start: number, count: number): void => {
						for (let index = start; index < start + count; index += 1) {
							instance.context.db
								.insert(schema.pendingUploads)
								.values({
									...pending,
									id: uploadIdSchema.parse(
										`claim-${String(index).padStart(8, '0')}`
									),
									settleRetryAfter: isoTimestampSchema.parse(
										'2999-01-01T00:00:00.000Z'
									)
								})
								.run();
						}
					};
					const measure = async <T>(run: () => Promise<T> | T) => {
						await instance.context.ctx.storage.delete(
							'maintenance:verification-decode-free-cursor'
						);
						instance.context.db
							.delete(schema.pendingUploads)
							.where(eq(schema.pendingUploads.id, dueId))
							.run();
						if (hasDue) {
							instance.context.db
								.insert(schema.pendingUploads)
								.values({ ...pending, id: dueId, settleRetryAfter: sql`null` })
								.run();
						}
						await new RetryClockService(instance.context).read();
						instance.context.dbCost.recordOutstanding();
						const before = instance.context.dbCost.rowsRead;
						const result = await asOneInvocation(run);
						instance.context.dbCost.recordOutstanding();
						return {
							result,
							rowsRead: instance.context.dbCost.rowsRead - before
						};
					};
					const all = async () => ({
						fresh: await measure(() =>
							withoutOwner(
								verification.listPendingForVerify(10, Number.MAX_SAFE_INTEGER)
							)
						),
						decodeFree: await measure(() =>
							verification.processPendingWithoutDecode(rootLogger(), 10)
						),
						hasPending: await measure(() => verification.hasPendingUploads())
					});
					seed(0, 3);
					const small = await all();
					seed(3, 197);
					const large = await all();
					return { small, large };
				}
			);
			expect(measured.small).toStrictEqual(measured.large);
			expect({
				fresh: measured.large.fresh.result,
				decodeFree: measured.large.decodeFree.result,
				hasPending: measured.large.hasPending.result
			}).toStrictEqual({
				fresh: {
					claims: hasDue ? claimOrder([{ ...upload, uploadId: dueId }]) : [],
					truncated: false
				},
				decodeFree: 0,
				hasPending: hasDue
			});
		});
	}
);
