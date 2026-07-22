import type { UploadId } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { pendingUploads } from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	currentServer,
	deferFreshUpload,
	initialise,
	listRoots,
	narInfoGeneration,
	pendingUploadVerdict,
	resetTestServer,
	setRoot
} from '../test-support.ts';

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

// Re-plants a cleared pending row as still awaiting its verdict, the state an
// eviction leaves when the narinfo object published but the clear-marker step
// never ran.
async function replantStuckPending(row: PendingRow): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema: { pendingUploads } })
			.insert(pendingUploads)
			.values({ ...row, verdict: 'pending', claimedAt: undefined })
			.run();
	});
}

// A verify pass re-claiming a row that already verified and materialised must
// finish its bookkeeping, not re-run the whole decode/promote/materialise saga.
// Here the private staging bytes are already gone, so a re-decode would wrongly
// fail the row `mismatch` and prune its root; the short-circuit settles it
// `servable` on the durable evidence: the generation-scoped reference edge and
// the published narinfo object.
describe('verify short-circuits an already-committed re-claim', () => {
	beforeEach(resetTestServer);

	it.each(['cron', 'queue'] as const)(
		'finalises a stuck already-committed row over the %s path',
		async (entry) => {
			const token = await initialise();
			const upload = await deferFreshUpload(
				token,
				'short-circuit',
				'b'.repeat(32)
			);
			const staged = await snapshotPendingRow(upload.uploadId);

			// Materialise it: the narinfo object publishes, the marker clears, and the
			// private staging object is reclaimed.
			await currentServer().runVerification();
			await setRoot(token, {
				name: 'main',
				targets: [upload.metadata.storePath]
			});

			await replantStuckPending(staged);

			if (entry === 'cron') {
				await currentServer().runVerification();
			} else {
				await currentServer().recordVerification(upload.uploadId, {
					ok: true,
					fileHash: upload.nar.fileHash,
					fileSize: upload.nar.narBytes.byteLength
				});
			}

			const object = await env.BLOBS.head(
				narInfoObjectKey(fixtureTenant, upload.metadata.storePathHash)
			);
			const { roots } = await listRoots(token);

			expect({
				verdict: await pendingUploadVerdict(upload.uploadId),
				generation: await narInfoGeneration(upload.metadata.storePathHash),
				served: object !== null,
				target: roots.at(0)?.targets.at(0)?.present
			}).toStrictEqual({
				verdict: undefined,
				generation: 0,
				served: true,
				target: true
			});
		}
	);
});
