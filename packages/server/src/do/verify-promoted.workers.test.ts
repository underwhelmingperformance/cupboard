import { rootLogger } from '@cupboard/logger';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { promoteVerifiedBlob } from '../blob/promote-blob.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { narInfoObjectKey, r2ObjectKeySchema } from '../http/http.ts';
import { verifyTenant } from '../routing/scheduled.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	blobStateNarHashes,
	commitPath,
	currentNarObjectKey,
	currentServer,
	currentServerTenant,
	deferFreshUpload,
	expectSingleCommitDecision,
	expectSingleUploadDecision,
	initialise,
	markUploadPendingVerification,
	negotiateUploads,
	pendingUploadVerdict,
	putNarBytes,
	resetTestServer,
	testBase,
	uploadMetadata,
	verifiableNar,
	verifiablePath,
	withoutAlarmArming
} from '../test-support.ts';

import { UploadStateService } from './upload-state-service.ts';

// An older consumer can report `promoted` after it has written the canonical
// object and `blob_state` row. The current Durable Object must still record that
// verdict without repeating the promotion during a rolling deployment.
describe('recording an older promoted verdict', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();
	});

	it('removes the pending refresh marker when its upload is cleared', async () => {
		const token = await initialise();
		const { metadata } = await verifiablePath('cleared-refresh-marker', {
			storePathHash: 'a'.repeat(32),
			name: 'cleared-refresh-marker'
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		const result = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const uploads = new UploadStateService(instance.context);
				await uploads.markPendingNarRefresh(upload.uploadId);
				const wasCleared = await uploads.clearPendingUpload(upload.uploadId, {
					logger: rootLogger(),
					outcome: 'servable'
				});
				return {
					wasCleared,
					refreshPending: uploads.hasPendingNarRefresh(upload.uploadId)
				};
			}
		);
		expect(result).toStrictEqual({ wasCleared: true, refreshPending: false });
	});

	it('imports a live legacy refresh beyond the first migration page before recovery', async () => {
		const token = await initialise();
		const { metadata } = await verifiablePath('legacy-refresh-page', {
			storePathHash: 'a'.repeat(32),
			name: 'legacy-refresh-page'
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		const result = await withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance, state) => {
				const uploads = new UploadStateService(instance.context);
				const keys = Array.from(
					{ length: 128 },
					(_, index) => `uploads:pending-nar-refresh:!orphan-${String(index)}`
				);
				await state.storage.put(
					Object.fromEntries(
						[...keys, `uploads:pending-nar-refresh:${upload.uploadId}`].map(
							(key) => [key, true]
						)
					)
				);
				await uploads.migratePendingNarRefreshMarkers(upload.uploadId);
				const isPending = uploads.hasPendingNarRefresh(upload.uploadId);
				await uploads.migratePendingNarRefreshMarkers();
				const legacy = await state.storage.list({
					prefix: 'uploads:pending-nar-refresh:'
				});
				await state.storage.deleteAlarm();
				return { isPending, legacy: [...legacy] };
			})
		);
		expect(result).toStrictEqual({
			isPending: true,
			legacy: [[`uploads:pending-nar-refresh:${upload.uploadId}`, true]]
		});
	});

	it('keeps new refresh intent readable by the predecessor until delivery', async () => {
		const token = await initialise();
		const { metadata } = await verifiablePath('rollback-refresh', {
			storePathHash: 'a'.repeat(32),
			name: 'rollback-refresh'
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		const result = await runInDurableObject(
			currentServer(),
			async (instance, state) => {
				const uploads = new UploadStateService(instance.context);
				await uploads.markPendingNarRefresh(upload.uploadId);
				return {
					current: uploads.hasPendingNarRefresh(upload.uploadId),
					predecessor: await state.storage.get(
						`uploads:pending-nar-refresh:${upload.uploadId}`
					)
				};
			}
		);
		expect(result).toStrictEqual({ current: true, predecessor: true });
	});

	it('resumes legacy migration beyond a retained page after restart', async () => {
		const token = await initialise();
		const { metadata } = await verifiablePath('retained-refresh-page', {
			storePathHash: 'a'.repeat(32),
			name: 'retained-refresh-page'
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		const result = await withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance, state) => {
				const ids = [
					...Array.from(
						{ length: 128 },
						(_, index) => `!live-${String(index).padStart(3, '0')}`
					),
					upload.uploadId
				];
				state.storage.sql.exec(
					'INSERT INTO pending_upload (id, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at) SELECT value, cache_id, nar_hash, r2_key, metadata_json, created_at, expires_at FROM json_each(?), pending_upload WHERE pending_upload.id = ?',
					JSON.stringify(ids.slice(0, 128)),
					upload.uploadId
				);
				await state.storage.put(
					Object.fromEntries(
						ids.map((id) => [`uploads:pending-nar-refresh:${id}`, true])
					)
				);
				await new UploadStateService(
					instance.context
				).migratePendingNarRefreshMarkers();
				const afterFirst = state.storage.sql
					.exec(
						'SELECT id FROM pending_upload WHERE nar_refresh_pending = 1 ORDER BY id'
					)
					.toArray();
				await new UploadStateService(
					instance.context
				).migratePendingNarRefreshMarkers();
				return {
					afterFirst,
					afterSecond: state.storage.sql
						.exec(
							'SELECT id FROM pending_upload WHERE nar_refresh_pending = 1 ORDER BY id'
						)
						.toArray(),
					legacy: [
						...(await state.storage.list({
							prefix: 'uploads:pending-nar-refresh:'
						}))
					]
				};
			})
		);
		const ids = [
			...Array.from(
				{ length: 128 },
				(_, index) => `!live-${String(index).padStart(3, '0')}`
			),
			upload.uploadId
		];
		expect(result).toStrictEqual({
			afterFirst: ids.slice(0, 128).map((id) => ({ id })),
			afterSecond: ids.map((id) => ({ id })),
			legacy: ids.map((id) => [`uploads:pending-nar-refresh:${id}`, true])
		});
	});

	it('defers a contended reservation without charging or discarding its verdict', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(
			token,
			'contended-verdict',
			'a'.repeat(32)
		);
		const result = await withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance, state) => {
				const claim = await instance.claimVerificationBatch(
					1,
					Number.MAX_SAFE_INTEGER
				);
				const database = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
				await database.insert(d1Schema.objectIncarnation).values({
					kind: 'nar',
					objectId: upload.nar.narHash,
					incarnation: 2,
					state: 'pending',
					reservationOwner: 'competing-owner',
					updatedAt: isoTimestamp(new Date())
				});
				const key = `uploads:pending-nar-refresh:${upload.uploadId}`;
				await state.storage.put(key, true);
				const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
				let batches = 0;
				const batch = vi
					.spyOn(env.CUPBOARD_DB, 'batch')
					.mockImplementation(async (statements) => {
						batches += 1;
						if (batches === 2) {
							await database
								.update(d1Schema.objectIncarnation)
								.set({ incarnation: 3 })
								.where(
									eq(d1Schema.objectIncarnation.objectId, upload.nar.narHash)
								)
								.run();
						}
						return originalBatch(statements);
					});
				const send = vi
					.spyOn(instance.context.env.MAINTENANCE_QUEUE, 'send')
					.mockResolvedValue({
						metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }
					});
				const usage = () =>
					database
						.select({
							bytes: d1Schema.tenantUsage.bytes,
							narinfos: d1Schema.tenantUsage.narinfos,
							blobs: d1Schema.tenantUsage.blobs
						})
						.from(d1Schema.tenantUsage)
						.where(
							eq(d1Schema.tenantUsage.tenant, instance.context.requireTenant())
						)
						.get();
				try {
					const applied = await instance.recordVerifications(claim.owner, [
						{
							uploadId: upload.uploadId,
							verdict: {
								kind: 'verified',
								verification: {
									ok: true,
									fileHash: upload.nar.fileHash,
									fileSize: upload.nar.narBytes.byteLength
								}
							}
						}
					]);
					const held = state.storage.sql
						.exec(
							'SELECT verdict, recorded_verdict_json IS NOT NULL AS recorded, nar_refresh_pending AS refresh, settle_failures AS failures FROM pending_upload WHERE id = ?',
							upload.uploadId
						)
						.one();
					const deferred = {
						applied,
						held,
						usage: await usage(),
						predecessor: await state.storage.get(key),
						queued: send.mock.calls.length
					};
					const beforeRetry = await instance.recordVerifications(
						claim.owner,
						[]
					);
					vi.setSystemTime(new Date(Date.now() + 1000));
					const retried = await instance.recordVerifications(claim.owner, []);
					return {
						deferred,
						beforeRetry,
						retried,
						usage: await usage(),
						remaining: state.storage.sql
							.exec(
								'SELECT id FROM pending_upload WHERE id = ?',
								upload.uploadId
							)
							.toArray(),
						predecessor: await state.storage.get(key),
						queued: send.mock.calls
					};
				} finally {
					batch.mockRestore();
					send.mockRestore();
				}
			})
		);
		expect(result).toStrictEqual({
			beforeRetry: 0,
			deferred: {
				applied: 0,
				held: { verdict: 'pending', recorded: 1, refresh: 1, failures: 0 },
				usage: { bytes: 0, narinfos: 0, blobs: 0 },
				predecessor: true,
				queued: 0
			},
			retried: 1,
			usage: { bytes: upload.nar.narBytes.byteLength, narinfos: 1, blobs: 1 },
			remaining: [],
			predecessor: undefined,
			queued: [[{ kind: 'narinfo-refresh', narHash: upload.nar.narHash }]]
		});
	});

	it('settles the upload without re-promoting', async () => {
		const token = await initialise();
		const { metadata, nar } = await verifiablePath('promoted-verdict', {
			storePathHash: 'a'.repeat(32),
			name: 'promoted-verdict'
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);

		// Reproduce the shared writes an older queue consumer performed.
		const d1 = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		await promoteVerifiedBlob(
			d1,
			env.BLOBS,
			r2ObjectKeySchema.parse(upload.r2Key),
			{ narHash: metadata.narHash, narSize: metadata.narSize },
			{ fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
		);
		const promotedAt = new Date().toISOString();

		// A settle that promoted again would advance `verified_at` past this.
		vi.setSystemTime(new Date(testBase.getTime() + 60_000));
		const claim = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);

		const applied = await currentServer().recordVerifications(claim.owner, [
			{ uploadId: upload.uploadId, verdict: { kind: 'promoted' } }
		]);

		const blobState = await d1
			.select({
				narHash: d1Schema.blobState.narHash,
				verifiedAt: d1Schema.blobState.verifiedAt
			})
			.from(d1Schema.blobState)
			.all();

		expect({
			applied,
			verdict: await pendingUploadVerdict(upload.uploadId),
			servable:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
						kind: 'default'
					})
				)) !== null,
			stagingGone: (await env.BLOBS.head(upload.r2Key)) === null,
			blobState
		}).toStrictEqual({
			applied: 1,
			verdict: undefined,
			servable: true,
			stagingGone: true,
			blobState: [{ narHash: metadata.narHash, verifiedAt: promotedAt }]
		});
	});
});

// The queue consumer's pass end to end: it decodes and reports off the Durable
// Object thread. The Durable Object promotes only while it owns the claim.
describe('consumer verify pass', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();
	});

	it('records a fresh deferred upload through an owner-checked promotion', async () => {
		const token = await initialise();
		const { metadata, nar } = await verifiablePath('consumer-promotes', {
			storePathHash: 'a'.repeat(32),
			name: 'consumer-promotes'
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);

		await verifyTenant(
			rootLogger(),
			env,
			new NarReadBufferPool(),
			currentServerTenant(),
			10
		);

		expect({
			verdict: await pendingUploadVerdict(upload.uploadId),
			blobState: await blobStateNarHashes(),
			servable:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, metadata.storePathHash, {
						kind: 'default'
					})
				)) !== null,
			stagingGone: (await env.BLOBS.head(upload.r2Key)) === null
		}).toStrictEqual({
			verdict: undefined,
			blobState: [{ narHash: metadata.narHash }],
			servable: true,
			stagingGone: true
		});
	});

	it('keeps the first upload complete when decoding the second upload fails', async () => {
		const token = await initialise();
		const first = await deferFreshUpload(token, 'progress-a', 'a'.repeat(32));
		const second = await deferFreshUpload(token, 'progress-b', 'b'.repeat(32));

		// The second upload's staging read fails before it produces a verdict. The
		// first upload's verdict was already recorded and remains complete.
		const originalGet = env.BLOBS.get.bind(env.BLOBS);
		const get = vi
			.spyOn(env.BLOBS, 'get')
			.mockImplementation((key, options) =>
				key === second.r2Key
					? Promise.reject(new Error('simulated staging outage'))
					: originalGet(key, options)
			);

		try {
			await verifyTenant(
				rootLogger(),
				env,
				new NarReadBufferPool(),
				currentServerTenant(),
				10
			);
		} finally {
			get.mockRestore();
		}

		expect({
			first: await pendingUploadVerdict(first.uploadId),
			second: await pendingUploadVerdict(second.uploadId)
		}).toStrictEqual({ first: undefined, second: 'pending' });

		vi.setSystemTime(new Date(Date.now() + 30_000));
		await verifyTenant(
			rootLogger(),
			env,
			new NarReadBufferPool(),
			currentServerTenant(),
			10
		);

		expect({
			first: await pendingUploadVerdict(first.uploadId),
			second: await pendingUploadVerdict(second.uploadId)
		}).toStrictEqual({ first: undefined, second: undefined });
	});

	it('settles a deferred reuse row without reading any bytes', async () => {
		const token = await initialise();
		const nar = await verifiableNar('consumer-reuse');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		const second = uploadMetadata({
			name: 'second',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [second]),
			second
		);
		await markUploadPendingVerification(reuse.uploadId);

		// A reuse claim may head the canonical object but must not fetch any object
		// body.
		const get = vi.spyOn(env.BLOBS, 'get');

		try {
			await verifyTenant(
				rootLogger(),
				env,
				new NarReadBufferPool(),
				currentServerTenant(),
				10
			);
		} finally {
			get.mockRestore();
		}

		expect({
			reads: get.mock.calls.length,
			verdict: await pendingUploadVerdict(reuse.uploadId),
			servable:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, second.storePathHash, {
						kind: 'default'
					})
				)) !== null,
			canonicalPresent:
				(await env.BLOBS.head(await currentNarObjectKey(nar.narHash))) !== null
		}).toStrictEqual({
			reads: 0,
			verdict: undefined,
			servable: true,
			canonicalPresent: true
		});
	});

	it('clears a deferred reuse row when its canonical object is missing', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reuse-vanished');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'c'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		const second = uploadMetadata({
			name: 'second',
			storePathHash: 'd'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [second]),
			second
		);

		await markUploadPendingVerification(reuse.uploadId);

		// The object was collected between negotiation and this pass. The server must
		// record a terminal result and tell the waiter to upload it again.
		await env.BLOBS.delete(await currentNarObjectKey(nar.narHash));

		await verifyTenant(
			rootLogger(),
			env,
			new NarReadBufferPool(),
			currentServerTenant(),
			10
		);

		expect({
			verdict: await pendingUploadVerdict(reuse.uploadId),
			servable:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, second.storePathHash, {
						kind: 'default'
					})
				)) !== null
		}).toStrictEqual({
			verdict: undefined,
			servable: false
		});
	});

	it('retries a reuse claim after a transient promotion fault and backoff', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reuse-transient');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'g'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		const second = uploadMetadata({
			name: 'second',
			storePathHash: 'h'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [second]),
			second
		);

		await markUploadPendingVerification(reuse.uploadId);

		const canonicalKey = await currentNarObjectKey(nar.narHash);
		const originalHead = env.BLOBS.head.bind(env.BLOBS);
		let shouldFail = true;
		const head = vi
			.spyOn(env.BLOBS, 'head')
			.mockImplementation(async (key: string) => {
				if (key === canonicalKey && shouldFail) {
					shouldFail = false;
					throw new Error('simulated canonical outage');
				}

				return originalHead(key);
			});

		try {
			await verifyTenant(
				rootLogger(),
				env,
				new NarReadBufferPool(),
				currentServerTenant(),
				10
			);

			expect(await pendingUploadVerdict(reuse.uploadId)).toBe('pending');

			await verifyTenant(
				rootLogger(),
				env,
				new NarReadBufferPool(),
				currentServerTenant(),
				10
			);
			expect(await pendingUploadVerdict(reuse.uploadId)).toBe('pending');

			vi.setSystemTime(new Date(Date.now() + 30_000));
			await verifyTenant(
				rootLogger(),
				env,
				new NarReadBufferPool(),
				currentServerTenant(),
				10
			);
		} finally {
			head.mockRestore();
		}

		expect({
			verdict: await pendingUploadVerdict(reuse.uploadId),
			servable:
				(await env.BLOBS.head(
					narInfoObjectKey(fixtureTenant, second.storePathHash, {
						kind: 'default'
					})
				)) !== null
		}).toStrictEqual({
			verdict: undefined,
			servable: true
		});
	});
});
