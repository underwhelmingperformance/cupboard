import type { UploadId } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { attestationInheritances, pendingUploads } from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	currentServer,
	deferFreshUpload,
	initialise,
	listRootTargets,
	narInfoGeneration,
	pendingUploadVerdict,
	putNarBytes,
	recordClaimedVerification,
	resetTestServer,
	runGcResult,
	setRoot,
	verifyCurrentTenant,
	withoutAlarmArming
} from '../test-support.ts';

import { AttestationsService } from './attestations-service.ts';

type PendingRow = typeof pendingUploads.$inferSelect;

async function snapshotPendingRow(uploadId: UploadId): Promise<PendingRow> {
	const row = await runInDurableObject(currentServer(), (_instance, state) =>
		drizzle(state.storage, { schema: { pendingUploads } })
			.select()
			.from(pendingUploads)
			.where(eq(pendingUploads.id, uploadId))
			.get()
	);

	if (row === undefined) {
		throw new Error(`no pending row for ${uploadId}`);
	}

	return row;
}

async function replantStuckPending(row: PendingRow): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema: { pendingUploads } })
			.insert(pendingUploads)
			.values({ ...row, verdict: 'pending', claimedAt: undefined })
			.run();
	});
}

// A crash after publishing narinfo but before clearing the pending row can leave
// no private staging bytes. Re-decoding that row would turn a committed upload
// into `mismatch` and prune its root.
describe('verification with a pending row left after commit', () => {
	beforeEach(resetTestServer);

	it.each(['inheritance', 'cleanup'] as const)(
		'finishes recovered publication when %s fails independently',
		async (failure) =>
			withoutAlarmArming(async () => {
				const token = await initialise();
				const upload = await deferFreshUpload(
					token,
					`recovered-${failure}`,
					'b'.repeat(32)
				);
				const staged = await snapshotPendingRow(upload.uploadId);
				await verifyCurrentTenant();
				await runInDurableObject(currentServer(), (instance) => {
					instance.context.db.delete(attestationInheritances).run();
				});
				await replantStuckPending(staged);
				await putNarBytes(upload.r2Key, upload.nar);
				const staging = await env.BLOBS.head(upload.r2Key);
				if (staging === null) {
					throw new Error('The recovered upload needs private staging bytes.');
				}
				const originalDelete = env.BLOBS.delete.bind(env.BLOBS);
				const fault =
					failure === 'inheritance'
						? vi
								.spyOn(AttestationsService.prototype, 'queueInheritance')
								.mockRejectedValueOnce(new Error('inheritance queue failed'))
						: vi
								.spyOn(env.BLOBS, 'delete')
								.mockImplementationOnce((key) =>
									key === upload.r2Key
										? Promise.reject(new Error('staging cleanup failed'))
										: originalDelete(key)
								);
				let first;
				try {
					await currentServer().claimVerificationBatch(
						1,
						Number.MAX_SAFE_INTEGER
					);
					first = await runInDurableObject(currentServer(), (instance) => ({
						pending: instance.context.db
							.select({ id: pendingUploads.id })
							.from(pendingUploads)
							.all(),
						inheritance: instance.context.db
							.select({
								storePathHash: attestationInheritances.storePathHash,
								narHash: attestationInheritances.narHash
							})
							.from(attestationInheritances)
							.all()
					}));
				} finally {
					fault.mockRestore();
				}
				vi.useFakeTimers({ toFake: ['Date'] });
				try {
					if (failure === 'inheritance') {
						vi.setSystemTime(new Date(Date.now() + 61_000));
						await verifyCurrentTenant();
					}
					vi.setSystemTime(
						new Date(staging.uploaded.getTime() + 20 * 60 * 1000)
					);
					await runGcResult();
				} finally {
					vi.useRealTimers();
				}
				const remaining = await runInDurableObject(
					currentServer(),
					(instance) => ({
						pending: instance.context.db
							.select({ id: pendingUploads.id })
							.from(pendingUploads)
							.all(),
						inheritance: instance.context.db
							.select({
								storePathHash: attestationInheritances.storePathHash,
								narHash: attestationInheritances.narHash
							})
							.from(attestationInheritances)
							.all()
					})
				);
				const inheritance = [
					{
						storePathHash: upload.metadata.storePathHash,
						narHash: upload.metadata.narHash
					}
				];
				expect({
					first,
					remaining,
					stagingPresent: (await env.BLOBS.head(upload.r2Key)) !== null
				}).toStrictEqual({
					first:
						failure === 'inheritance'
							? {
									pending: [{ id: upload.uploadId }],
									inheritance: []
								}
							: { pending: [], inheritance },
					remaining: { pending: [], inheritance },
					stagingPresent: false
				});
			})
	);

	it.each(['cron', 'queue'] as const)(
		'clears the stale pending row without changing the committed path when started by %s',
		async (entry) => {
			const token = await initialise();
			const upload = await deferFreshUpload(
				token,
				'short-circuit',
				'b'.repeat(32)
			);
			const staged = await snapshotPendingRow(upload.uploadId);

			await verifyCurrentTenant();
			await setRoot(token, {
				name: 'main',
				targets: [upload.metadata.storePath]
			});

			await replantStuckPending(staged);

			if (entry === 'cron') {
				await verifyCurrentTenant();
			} else {
				await recordClaimedVerification(upload.uploadId, {
					ok: true,
					fileHash: upload.nar.fileHash,
					fileSize: upload.nar.narBytes.byteLength
				});
			}

			const object = await env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, upload.metadata.storePathHash, {
					kind: 'default'
				})
			);
			const { targets } = await listRootTargets(token, 'main');

			expect({
				verdict: await pendingUploadVerdict(upload.uploadId),
				generation: await narInfoGeneration(upload.metadata.storePathHash),
				served: object !== null,
				target: targets.at(0)?.present
			}).toStrictEqual({
				verdict: undefined,
				generation: 0,
				served: true,
				target: true
			});
		}
	);

	it('does not accept a stale narinfo object for the committed generation', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(
			token,
			'short-circuit-version',
			'b'.repeat(32)
		);
		const staged = await snapshotPendingRow(upload.uploadId);
		const objectKey = narInfoObjectKey(
			fixtureTenant,
			upload.metadata.storePathHash,
			{ kind: 'default' }
		);

		await verifyCurrentTenant();

		const published = await env.BLOBS.get(objectKey);

		if (published === null) {
			throw new Error('expected the committed narinfo object');
		}

		await env.BLOBS.put(objectKey, published.body, {
			customMetadata: {
				...published.customMetadata,
				generation: '99'
			}
		});
		await replantStuckPending(staged);
		await putNarBytes(upload.r2Key, upload.nar);

		await recordClaimedVerification(upload.uploadId, {
			ok: true,
			fileHash: upload.nar.fileHash,
			fileSize: upload.nar.narBytes.byteLength
		});

		const restored = await env.BLOBS.head(objectKey);

		expect({
			verdict: await pendingUploadVerdict(upload.uploadId),
			metadata: restored?.customMetadata
		}).toStrictEqual({
			verdict: undefined,
			metadata: published.customMetadata
		});
	});
});
