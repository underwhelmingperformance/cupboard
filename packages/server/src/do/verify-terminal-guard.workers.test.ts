import { rootLogger } from '@cupboard/logger';
import {
	type NixSha256HashString,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import type { UploadId } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lateWriteTombstoneHorizonMs } from '../blob/object-incarnation.ts';
import { drainObjectDeletions } from '../blob/object-incarnation-recovery.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { pendingUploads } from '../db/schema.ts';
import {
	narInfoObjectKey,
	narObjectKey,
	type R2ObjectKey,
	r2ObjectKeySchema,
	verifyClaimLeaseMs
} from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	currentServer,
	deleteBlobState,
	expectSingleUploadDecision,
	fileHash,
	initialise,
	markUploadPendingVerification,
	narBytes,
	narInfoGeneration,
	negotiateUploads,
	openCommitSession,
	pendingUploadSnapshot,
	putNarBytes,
	resetTestServer,
	seedCanonicalBlob,
	seedReservedNarInfo,
	syntheticNarHash,
	testBase,
	uploadMetadata
} from '../test-support.ts';

import { type CommitPipelineService } from './commit-pipeline-service.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import { UploadStateService } from './upload-state-service.ts';
import { type VerificationService } from './verification-service.ts';

async function deferredUpload(options?: {
	seedCanonical?: boolean;
	narHash?: NixSha256HashString;
}): Promise<{
	token: string;
	uploadId: UploadId;
	storePathHash: StorePathHash;
	narHash: NixSha256HashString;
	r2Key: R2ObjectKey;
	metadata: ReturnType<typeof uploadMetadata>;
}> {
	const token = await initialise();
	const metadata = uploadMetadata({
		fileSize: narBytes.byteLength,
		...(options?.narHash !== undefined && { narHash: options.narHash })
	});
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);

	await putNarBytes(upload.r2Key);
	await markUploadPendingVerification(upload.uploadId);

	// The `blob_state` row and canonical R2 object exist, as they do when promotion
	// finishes before the upload receives a terminal verdict. Without the owner
	// check, an older pass could continue to materialisation from those bytes.
	if (options?.seedCanonical !== false) {
		await seedCanonicalBlob({
			narBytes,
			narHash: metadata.narHash,
			narSize: metadata.narSize,
			fileHash: metadata.fileHash
		});
	}

	return {
		token,
		uploadId: upload.uploadId,
		storePathHash: metadata.storePathHash,
		narHash: metadata.narHash,
		r2Key: r2ObjectKeySchema.parse(upload.r2Key),
		metadata
	};
}

async function isNarInfoObjectPresent(
	storePathHash: StorePathHash
): Promise<boolean> {
	const object = await env.BLOBS.head(
		narInfoObjectKey(fixtureTenant, storePathHash)
	);

	return object !== null;
}

// A terminal verdict remains authoritative throughout its observation window.
// Verify passes can overlap, so a later verdict must not reopen or serve a row
// that another pass has settled.
describe('terminal verdicts against straggling verifications', () => {
	beforeEach(resetTestServer);

	it.each(['success', 'mismatch', 'missing', 'batch'] as const)(
		'ignores a stale legacy %s after a replacement claims the row',
		async (kind) => {
			const upload = await deferredUpload({ seedCanonical: false });

			const result = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const database = drizzle(state.storage, {
						schema: { pendingUploads }
					});
					database
						.update(pendingUploads)
						.set({
							claimedAt: isoTimestamp(new Date()),
							claimOwner: sql`null`
						})
						.where(eq(pendingUploads.id, upload.uploadId))
						.run();

					new UploadStateService(instance.context).markUploadPending(
						upload.uploadId
					);
					const verification = (
						instance as unknown as { verification: VerificationService }
					).verification;
					const replacement = verification.listPendingForVerify(
						10,
						Number.MAX_SAFE_INTEGER
					);
					if (kind === 'batch') {
						await instance.recordVerifications([
							{
								uploadId: upload.uploadId,
								verdict: {
									kind: 'verified',
									verification: {
										ok: true,
										fileHash: fileHash.value,
										fileSize: narBytes.byteLength
									}
								}
							}
						]);
					} else if (kind === 'missing') {
						await instance.recordMissingObject(upload.uploadId);
					} else {
						await instance.recordVerification(
							upload.uploadId,
							kind === 'success'
								? {
										ok: true,
										fileHash: fileHash.value,
										fileSize: narBytes.byteLength
									}
								: {
										ok: false,
										reason: 'nar-hash-mismatch',
										actualNarHash: upload.narHash
									}
						);
					}

					const row = database
						.select({
							verdict: pendingUploads.verdict,
							claimOwner: pendingUploads.claimOwner
						})
						.from(pendingUploads)
						.where(eq(pendingUploads.id, upload.uploadId))
						.get();

					return { replacement, row };
				}
			);

			expect({
				row: result.row,
				generation: await narInfoGeneration(upload.storePathHash),
				stagingPresent: (await env.BLOBS.head(upload.r2Key)) !== null
			}).toStrictEqual({
				row: {
					verdict: 'pending',
					claimOwner: result.replacement.owner
				},
				generation: undefined,
				stagingPresent: true
			});
		}
	);

	it('does not let a legacy caller take over an expired ownerless lease', async () => {
		const upload = await deferredUpload({
			seedCanonical: false,
			narHash: syntheticNarHash(867_530_900)
		});

		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const database = drizzle(state.storage, { schema: { pendingUploads } });
				const expiredAt = new Date(Date.now() - verifyClaimLeaseMs - 1);
				database
					.update(pendingUploads)
					.set({
						claimedAt: isoTimestamp(expiredAt),
						claimOwner: sql`null`
					})
					.where(eq(pendingUploads.id, upload.uploadId))
					.run();
				const legacyClaims = await instance.claimPendingVerifications(10);

				const verification = (
					instance as unknown as { verification: VerificationService }
				).verification;
				const replacement = verification.listPendingForVerify(
					10,
					Number.MAX_SAFE_INTEGER
				);
				const row = database
					.select({ claimOwner: pendingUploads.claimOwner })
					.from(pendingUploads)
					.where(eq(pendingUploads.id, upload.uploadId))
					.get();

				return { legacyClaims, replacement, row };
			}
		);

		expect({
			legacyClaims: result.legacyClaims,
			claimedUploadIds: result.replacement.claims.map(
				(claim) => claim.uploadId
			),
			claimOwner: result.row?.claimOwner
		}).toStrictEqual({
			legacyClaims: [],
			claimedUploadIds: [upload.uploadId],
			claimOwner: result.replacement.owner
		});
	});

	it('leaves a settled row untouched by a straggling good verdict', async () => {
		const upload = await deferredUpload();
		const claim = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);

		await currentServer().recordVerifications(claim.owner, [
			{
				uploadId: upload.uploadId,
				verdict: {
					kind: 'verified',
					verification: {
						ok: false,
						reason: 'nar-hash-mismatch',
						actualNarHash: upload.narHash
					}
				}
			}
		]);
		const settled = await pendingUploadSnapshot(upload.uploadId);

		expect(settled).toStrictEqual({
			verdict: 'mismatch',
			expiresAt: expect.any(String) as string
		});

		await currentServer().recordVerifications(claim.owner, [
			{
				uploadId: upload.uploadId,
				verdict: {
					kind: 'verified',
					verification: {
						ok: true,
						fileHash: fileHash.value,
						fileSize: narBytes.byteLength
					}
				}
			}
		]);

		expect({
			row: await pendingUploadSnapshot(upload.uploadId),
			generation: await narInfoGeneration(upload.storePathHash),
			object: await isNarInfoObjectPresent(upload.storePathHash)
		}).toStrictEqual({
			row: settled,
			generation: undefined,
			object: false
		});
	});

	it('does not serve an upload that becomes terminal during verification', async () => {
		const upload = await deferredUpload();
		const claim = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);

		// Hold the straggler after it prepares the physical object while a competing
		// pass records a terminal verdict. The straggler passed its entry check on
		// the still-pending row, so only the gate's re-read can stop it. The whole
		// interleave runs inside the Durable Object so no promise crosses request
		// contexts.
		const settled = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const verification = (
					instance as unknown as { verification: VerificationService }
				).verification;
				const uploadState = (
					verification as unknown as { uploadState: UploadStateService }
				).uploadState;
				const snapshot = (): unknown =>
					drizzle(state.storage, { schema: { pendingUploads } })
						.select({
							verdict: pendingUploads.verdict,
							expiresAt: pendingUploads.expiresAt
						})
						.from(pendingUploads)
						.where(eq(pendingUploads.id, upload.uploadId))
						.get();
				const originalStage = uploadState.stageStagingBlob.bind(uploadState);
				const {
					promise: held,
					resolve: releaseHead
				}: PromiseWithResolvers<void> = Promise.withResolvers();
				const {
					promise: promoteReached,
					resolve: reachedPromote
				}: PromiseWithResolvers<void> = Promise.withResolvers();
				const stage = vi
					.spyOn(uploadState, 'stageStagingBlob')
					.mockImplementation(async (...parameters) => {
						const prepared = await originalStage(...parameters);
						reachedPromote();
						await held;

						return prepared;
					});

				try {
					const straggler = verification.recordVerifications(
						rootLogger(),
						claim.owner,
						[
							{
								uploadId: upload.uploadId,
								verdict: {
									kind: 'verified',
									verification: {
										ok: true,
										fileHash: fileHash.value,
										fileSize: narBytes.byteLength
									}
								}
							}
						]
					);

					await promoteReached;
					await verification.recordVerifications(rootLogger(), claim.owner, [
						{
							uploadId: upload.uploadId,
							verdict: {
								kind: 'verified',
								verification: {
									ok: false,
									reason: 'nar-hash-mismatch',
									actualNarHash: upload.narHash
								}
							}
						}
					]);
					const terminal = snapshot();

					releaseHead();
					await straggler;

					return terminal;
				} finally {
					stage.mockRestore();
				}
			}
		);

		expect(settled).toStrictEqual({
			verdict: 'mismatch',
			expiresAt: expect.any(String) as string
		});
		expect({
			row: await pendingUploadSnapshot(upload.uploadId),
			generation: await narInfoGeneration(upload.storePathHash),
			object: await isNarInfoObjectPresent(upload.storePathHash)
		}).toStrictEqual({
			row: settled,
			generation: undefined,
			object: false
		});
	});

	it('does not reserve a generation after the claim changes during signing', async () => {
		const upload = await deferredUpload({
			seedCanonical: false,
			narHash: syntheticNarHash(867_530_901)
		});
		const oldClaim = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);

		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const verification = (
					instance as unknown as { verification: VerificationService }
				).verification;
				const pipeline = (
					verification as unknown as {
						commitPipeline: CommitPipelineService;
					}
				).commitPipeline;
				const signingKeysService = (
					pipeline as unknown as {
						signingKeysService: {
							signingKeys: () => Promise<readonly unknown[]>;
						};
					}
				).signingKeysService;
				const original =
					signingKeysService.signingKeys.bind(signingKeysService);
				const { promise: held, resolve: release } =
					Promise.withResolvers<undefined>();
				const { promise: reached, resolve: didReach } =
					Promise.withResolvers<undefined>();
				const signingKeys = vi
					.spyOn(signingKeysService, 'signingKeys')
					.mockImplementation(async () => {
						didReach(undefined);
						await held;

						return original();
					});

				try {
					const stale = verification.recordVerifications(
						rootLogger(),
						oldClaim.owner,
						[
							{
								uploadId: upload.uploadId,
								verdict: {
									kind: 'verified',
									verification: {
										ok: true,
										fileHash: fileHash.value,
										fileSize: narBytes.byteLength
									}
								}
							}
						]
					);

					await reached;
					new UploadStateService(instance.context).markUploadPending(
						upload.uploadId
					);
					const replacement = verification.listPendingForVerify(
						10,
						Number.MAX_SAFE_INTEGER
					);
					release(undefined);

					return { applied: await stale, replacement };
				} finally {
					signingKeys.mockRestore();
				}
			}
		);

		expect({
			applied: result.applied,
			generation: await narInfoGeneration(upload.storePathHash),
			replacement: result.replacement.claims.map((claim) => claim.uploadId)
		}).toStrictEqual({
			applied: 0,
			generation: undefined,
			replacement: [upload.uploadId]
		});
	});

	it('isolates physical bytes written after a claim changes', async () => {
		const upload = await deferredUpload({ seedCanonical: false });
		await deleteBlobState(upload.narHash);
		const oldClaim = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);
		let staleIncarnation: number | undefined;

		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const verification = (
					instance as unknown as { verification: VerificationService }
				).verification;
				const uploadState = (
					verification as unknown as { uploadState: UploadStateService }
				).uploadState;
				const originalStage = uploadState.stageStagingBlob.bind(uploadState);
				const { promise: held, resolve: release } =
					Promise.withResolvers<undefined>();
				const { promise: reached, resolve: didReach } =
					Promise.withResolvers<undefined>();
				let isHolding = true;
				const stage = vi
					.spyOn(uploadState, 'stageStagingBlob')
					.mockImplementation(async (...parameters) => {
						const prepared = await originalStage(...parameters);

						if (isHolding) {
							isHolding = false;
							staleIncarnation = prepared?.incarnation;
							didReach(undefined);
							await held;
						}

						return prepared;
					});

				try {
					const stale = verification.recordVerifications(
						rootLogger(),
						oldClaim.owner,
						[
							{
								uploadId: upload.uploadId,
								verdict: {
									kind: 'verified',
									verification: {
										ok: true,
										fileHash: fileHash.value,
										fileSize: narBytes.byteLength
									}
								}
							}
						]
					);

					await reached;
					new UploadStateService(instance.context).markUploadPending(
						upload.uploadId
					);
					const replacement = verification.listPendingForVerify(
						10,
						Number.MAX_SAFE_INTEGER
					);
					release(undefined);
					const applied = await stale;

					await verification.recordVerifications(
						rootLogger(),
						replacement.owner,
						[
							{
								uploadId: upload.uploadId,
								verdict: {
									kind: 'verified',
									verification: {
										ok: true,
										fileHash: fileHash.value,
										fileSize: narBytes.byteLength
									}
								}
							}
						]
					);

					return { applied, replacement };
				} finally {
					stage.mockRestore();
				}
			}
		);

		if (staleIncarnation === undefined) {
			throw new Error('The stale promotion did not reserve an incarnation.');
		}

		const staleKey = narObjectKey(upload.narHash, staleIncarnation);
		const [blob] = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.select({ incarnation: d1Schema.blobState.incarnation })
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, upload.narHash));
		const markers = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.select({ incarnation: d1Schema.objectDeletion.incarnation })
			.from(d1Schema.objectDeletion)
			.where(eq(d1Schema.objectDeletion.objectId, upload.narHash));

		const activeIncarnation = blob?.incarnation;
		const activeKey =
			activeIncarnation === undefined
				? undefined
				: narObjectKey(upload.narHash, activeIncarnation);

		expect({
			staleApplied: result.applied,
			activeIsLaterThanStale:
				activeIncarnation !== undefined && activeIncarnation > staleIncarnation,
			staleIsQueuedOrGone:
				markers.some((marker) => marker.incarnation === staleIncarnation) ||
				(await env.BLOBS.head(staleKey)) === null,
			activeBytesPresent:
				activeKey !== undefined && (await env.BLOBS.head(activeKey)) !== null,
			row: await pendingUploadSnapshot(upload.uploadId)
		}).toStrictEqual({
			staleApplied: 0,
			activeIsLaterThanStale: true,
			staleIsQueuedOrGone: true,
			activeBytesPresent: true,
			row: undefined
		});
	});

	it('requeues a stale incarnation when its write lands after deletion', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		const upload = await deferredUpload({
			seedCanonical: false,
			narHash: syntheticNarHash(867_530_901)
		});
		await deleteBlobState(upload.narHash);
		const oldClaim = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);
		let staleKey: string | undefined;

		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const verification = (
					instance as unknown as { verification: VerificationService }
				).verification;
				const originalPut = env.BLOBS.put.bind(env.BLOBS);
				const { promise: held, resolve: release } =
					Promise.withResolvers<undefined>();
				const { promise: reached, resolve: didReach } =
					Promise.withResolvers<undefined>();
				let didHold = false;
				const put = vi
					.spyOn(env.BLOBS, 'put')
					.mockImplementation(async (key, value, options) => {
						if (!didHold && key !== upload.r2Key) {
							didHold = true;
							staleKey = key;
							didReach(undefined);
							await held;
						}

						return originalPut(key, value, options);
					});

				const originalPrepare = env.CUPBOARD_DB.prepare.bind(env.CUPBOARD_DB);
				let shouldRejectRepair = false;
				const prepare = vi
					.spyOn(env.CUPBOARD_DB, 'prepare')
					.mockImplementation((query) => {
						if (
							shouldRejectRepair &&
							typeof query === 'string' &&
							query.includes('insert into "object_deletion"')
						) {
							throw new Error('simulated tombstone repair outage');
						}

						return originalPrepare(query);
					});

				try {
					const stale = verification.recordVerifications(
						rootLogger(),
						oldClaim.owner,
						[
							{
								uploadId: upload.uploadId,
								verdict: {
									kind: 'verified',
									verification: {
										ok: true,
										fileHash: fileHash.value,
										fileSize: narBytes.byteLength
									}
								}
							}
						]
					);

					await reached;
					new UploadStateService(instance.context).markUploadPending(
						upload.uploadId
					);
					const replacement = verification.listPendingForVerify(
						10,
						Number.MAX_SAFE_INTEGER
					);
					await verification.recordVerifications(
						rootLogger(),
						replacement.owner,
						[
							{
								uploadId: upload.uploadId,
								verdict: {
									kind: 'verified',
									verification: {
										ok: true,
										fileHash: fileHash.value,
										fileSize: narBytes.byteLength
									}
								}
							}
						]
					);
					await drainObjectDeletions(instance.context.d1, env.BLOBS, 'nar', 10);
					const markerAfterEarlyDelete = await instance.context.d1
						.select({ incarnation: d1Schema.objectDeletion.incarnation })
						.from(d1Schema.objectDeletion)
						.where(eq(d1Schema.objectDeletion.objectId, upload.narHash));
					shouldRejectRepair = true;
					release(undefined);
					const applied = await stale;

					return { applied, markerAfterEarlyDelete, replacement };
				} finally {
					put.mockRestore();
					prepare.mockRestore();
				}
			}
		);

		if (staleKey === undefined) {
			throw new Error('The stale canonical write did not start.');
		}

		const [active] = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.select({ incarnation: d1Schema.blobState.incarnation })
			.from(d1Schema.blobState)
			.where(eq(d1Schema.blobState.narHash, upload.narHash));
		const markers = await drizzleD1(env.CUPBOARD_DB, { schema: d1Schema })
			.select({ incarnation: d1Schema.objectDeletion.incarnation })
			.from(d1Schema.objectDeletion)
			.where(eq(d1Schema.objectDeletion.objectId, upload.narHash));
		const staleMatch = /\.(\d+)\.nar\.zst$/u.exec(staleKey);
		const staleIncarnation = Number(staleMatch?.[1]);

		expect({
			applied: result.applied,
			staleMarkerAfterEarlyDelete: result.markerAfterEarlyDelete.some(
				(marker) => marker.incarnation === staleIncarnation
			),
			staleMarkerAfterLateWrite: markers.some(
				(marker) => marker.incarnation === staleIncarnation
			),
			stalePresent: (await env.BLOBS.head(staleKey)) !== null,
			activeIsReplacement:
				active !== undefined && active.incarnation > staleIncarnation
		}).toStrictEqual({
			applied: 0,
			staleMarkerAfterEarlyDelete: true,
			staleMarkerAfterLateWrite: true,
			stalePresent: true,
			activeIsReplacement: true
		});

		vi.setSystemTime(
			new Date(testBase.getTime() + lateWriteTombstoneHorizonMs)
		);
		const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		const batch = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockRejectedValueOnce(new Error('simulated marker removal outage'));

		await expect(
			drainObjectDeletions(
				drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
				env.BLOBS,
				'nar',
				10
			)
		).rejects.toThrow('simulated marker removal outage');
		batch.mockImplementation(originalBatch);

		const markersAfterFailedRemoval = await drizzleD1(env.CUPBOARD_DB, {
			schema: d1Schema
		})
			.select({ incarnation: d1Schema.objectDeletion.incarnation })
			.from(d1Schema.objectDeletion)
			.where(eq(d1Schema.objectDeletion.objectId, upload.narHash));

		expect({
			staleMarkerPresent: markersAfterFailedRemoval.some(
				(marker) => marker.incarnation === staleIncarnation
			),
			stalePresent: (await env.BLOBS.head(staleKey)) !== null
		}).toStrictEqual({
			staleMarkerPresent: true,
			stalePresent: false
		});

		await drainObjectDeletions(
			drizzleD1(env.CUPBOARD_DB, { schema: d1Schema }),
			env.BLOBS,
			'nar',
			10
		);
		batch.mockRestore();

		expect({
			stalePresent: (await env.BLOBS.head(staleKey)) !== null,
			activePresent:
				active !== undefined &&
				(await env.BLOBS.head(
					narObjectKey(upload.narHash, active.incarnation)
				)) !== null
		}).toStrictEqual({ stalePresent: false, activePresent: true });
		vi.useRealTimers();
	});

	it.each(['mismatch', 'missing'] as const)(
		'notifies a %s waiter when private staging cleanup fails',
		async (kind) => {
			const upload = await deferredUpload();
			const session = await openCommitSession(upload.token);
			session.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
			const subscribed = await session.nextFrame();
			expect(subscribed.ev).toBe('deferred');
			const claim = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			try {
				const verdict =
					kind === 'missing'
						? ({ kind: 'missing' } as const)
						: ({
								kind: 'verified',
								verification: {
									ok: false,
									reason: 'nar-hash-mismatch',
									actualNarHash: upload.narHash
								}
							} as const);
				const applied = await runInDurableObject(
					currentServer(),
					async (instance) => {
						const verification = (
							instance as unknown as { verification: VerificationService }
						).verification;
						const deletion = vi
							.spyOn(
								verification as unknown as {
									deleteStagingObject: () => Promise<void>;
								},
								'deleteStagingObject'
							)
							.mockImplementation(() => {
								throw new Error('simulated staging delete failure');
							});

						try {
							return await verification.recordVerifications(
								rootLogger(),
								claim.owner,
								[{ uploadId: upload.uploadId, verdict }]
							);
						} finally {
							deletion.mockRestore();
						}
					}
				);

				expect({
					applied,
					frame: await session.nextFrame(),
					row: await pendingUploadSnapshot(upload.uploadId),
					stagingPresent: (await env.BLOBS.head(upload.r2Key)) !== null
				}).toStrictEqual({
					applied: 1,
					frame: {
						ev: 'verdict',
						uploadId: upload.uploadId,
						status: 'mismatch'
					},
					row: {
						verdict: 'mismatch',
						expiresAt: expect.any(String) as string
					},
					stagingPresent: true
				});
			} finally {
				session.socket.close();
			}
		}
	);

	it.each(['mismatch', 'missing'] as const)(
		'does not let a revoked owner record a %s verdict after reclaim waits',
		async (kind) => {
			const upload = await deferredUpload();
			const canonicalKey = narObjectKey(upload.narHash);

			const session = await openCommitSession(upload.token);
			session.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
			const subscribed = await session.nextFrame();
			expect(subscribed.ev).toBe('deferred');
			const oldClaim = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);
			expect(oldClaim.claims.map((claim) => claim.uploadId)).toStrictEqual([
				upload.uploadId
			]);

			if (kind === 'missing') {
				await seedReservedNarInfo(upload.metadata, 0);
				await runInDurableObject(currentServer(), (_instance, state) => {
					drizzle(state.storage, { schema: { pendingUploads } })
						.update(pendingUploads)
						.set({ r2Key: canonicalKey })
						.where(eq(pendingUploads.id, upload.uploadId))
						.run();
				});
			}

			const result = await runInDurableObject(
				currentServer(),
				async (instance, state) => {
					const verification = (
						instance as unknown as { verification: VerificationService }
					).verification;
					const pipeline = (
						verification as unknown as {
							commitPipeline: CommitPipelineService;
						}
					).commitPipeline;
					const originalReclaim = pipeline.reclaimReservedRow.bind(pipeline);
					const { promise: held, resolve: release } =
						Promise.withResolvers<undefined>();
					const { promise: reached, resolve: didReach } =
						Promise.withResolvers<undefined>();
					const reclaim = vi
						.spyOn(pipeline, 'reclaimReservedRow')
						.mockImplementation(async (...arguments_) => {
							didReach(undefined);
							await held;
							return originalReclaim(...arguments_);
						});

					try {
						const stale = verification.recordVerifications(
							rootLogger(),
							oldClaim.owner,
							[
								{
									uploadId: upload.uploadId,
									verdict:
										kind === 'missing'
											? { kind: 'missing' }
											: {
													kind: 'verified',
													verification: {
														ok: false,
														reason: 'nar-hash-mismatch',
														actualNarHash: upload.narHash
													}
												}
								}
							]
						);

						await reached;
						new UploadStateService(instance.context).markUploadPending(
							upload.uploadId
						);
						if (kind === 'missing') {
							drizzle(state.storage, { schema: { pendingUploads } })
								.update(pendingUploads)
								.set({ r2Key: upload.r2Key })
								.where(eq(pendingUploads.id, upload.uploadId))
								.run();
						}
						const replacement = verification.listPendingForVerify(
							10,
							Number.MAX_SAFE_INTEGER
						);
						release(undefined);
						const applied = await stale;
						const row = drizzle(state.storage, {
							schema: { pendingUploads }
						})
							.select({
								verdict: pendingUploads.verdict,
								claimOwner: pendingUploads.claimOwner
							})
							.from(pendingUploads)
							.where(eq(pendingUploads.id, upload.uploadId))
							.get();

						return { applied, replacement, row };
					} finally {
						reclaim.mockRestore();
					}
				}
			);

			expect({
				applied: result.applied,
				row: result.row,
				generation: await narInfoGeneration(upload.storePathHash),
				stagingPresent: (await env.BLOBS.head(upload.r2Key)) !== null,
				replacementOwnsRow: result.row?.claimOwner === result.replacement.owner
			}).toStrictEqual({
				applied: 0,
				row: {
					verdict: 'pending',
					claimOwner: result.replacement.owner
				},
				generation: 0,
				stagingPresent: true,
				replacementOwnsRow: true
			});

			await currentServer().recordVerifications(result.replacement.owner, [
				{
					uploadId: upload.uploadId,
					verdict: {
						kind: 'verified',
						verification: {
							ok: true,
							fileHash: fileHash.value,
							fileSize: narBytes.byteLength
						}
					}
				}
			]);

			expect(await session.nextFrame()).toStrictEqual({
				ev: 'verdict',
				uploadId: upload.uploadId,
				status: 'servable'
			});
			session.socket.close();
		}
	);

	it('does not let a revoked owner finish materialisation after publication waits', async () => {
		const upload = await deferredUpload();
		const session = await openCommitSession(upload.token);
		session.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
		const subscribed = await session.nextFrame();
		expect(subscribed.ev).toBe('deferred');
		const oldClaim = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const verification = (
					instance as unknown as { verification: VerificationService }
				).verification;
				const narInfoObjects = (
					verification as unknown as {
						narInfoObjects: NarInfoObjectsService;
					}
				).narInfoObjects;
				const originalPut =
					narInfoObjects.putNarInfoObject.bind(narInfoObjects);
				const { promise: held, resolve: release } =
					Promise.withResolvers<undefined>();
				const { promise: reached, resolve: didReach } =
					Promise.withResolvers<undefined>();
				const put = vi
					.spyOn(narInfoObjects, 'putNarInfoObject')
					.mockImplementation(async (...parameters) => {
						await originalPut(...parameters);
						didReach(undefined);
						await held;
					});

				try {
					const stale = verification.recordVerifications(
						rootLogger(),
						oldClaim.owner,
						[
							{
								uploadId: upload.uploadId,
								verdict: {
									kind: 'verified',
									verification: {
										ok: true,
										fileHash: fileHash.value,
										fileSize: narBytes.byteLength
									}
								}
							}
						]
					);

					await reached;
					new UploadStateService(instance.context).markUploadPending(
						upload.uploadId
					);
					const replacement = verification.listPendingForVerify(
						10,
						Number.MAX_SAFE_INTEGER
					);
					release(undefined);
					const applied = await stale;
					const row = drizzle(state.storage, {
						schema: { pendingUploads }
					})
						.select({
							verdict: pendingUploads.verdict,
							claimOwner: pendingUploads.claimOwner
						})
						.from(pendingUploads)
						.where(eq(pendingUploads.id, upload.uploadId))
						.get();

					return { applied, replacement, row };
				} finally {
					put.mockRestore();
				}
			}
		);

		expect({
			applied: result.applied,
			row: result.row,
			generation: await narInfoGeneration(upload.storePathHash),
			stagingPresent: (await env.BLOBS.head(upload.r2Key)) !== null,
			replacementOwnsRow: result.row?.claimOwner === result.replacement.owner
		}).toStrictEqual({
			applied: 0,
			row: {
				verdict: 'pending',
				claimOwner: result.replacement.owner
			},
			generation: 0,
			stagingPresent: true,
			replacementOwnsRow: true
		});

		await currentServer().recordVerifications(result.replacement.owner, [
			{
				uploadId: upload.uploadId,
				verdict: {
					kind: 'verified',
					verification: {
						ok: true,
						fileHash: fileHash.value,
						fileSize: narBytes.byteLength
					}
				}
			}
		]);
		expect(await session.nextFrame()).toStrictEqual({
			ev: 'verdict',
			uploadId: upload.uploadId,
			status: 'servable'
		});
		session.socket.close();
	});
});
