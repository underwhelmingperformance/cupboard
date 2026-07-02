import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { promoteVerifiedBlob } from '../blob/promote-blob.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	currentServer,
	expectSingleUploadDecision,
	initialise,
	markUploadPendingVerification,
	negotiateUploads,
	pendingUploadVerdict,
	putNarBytes,
	resetTestServer,
	testBase,
	verifiablePath
} from '../test-support.ts';

// A `promoted` verdict says the reporter already promoted the verified bytes:
// the canonical object and its `blob_state` row are durable, so the settle owes
// only the reserve, materialise and notify. This drives one through the batch
// RPC and proves the settle ran no promote of its own.
describe('recording a promoted verdict', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();
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

		// The reporter's promote, as the queue consumer runs it after decoding.
		const d1 = drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
		await promoteVerifiedBlob(
			d1,
			env.BLOBS,
			upload.r2Key,
			{ narHash: metadata.narHash, narSize: metadata.narSize },
			{ fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
		);
		const promotedAt = new Date().toISOString();

		// A settle that promoted again would advance `verified_at` past this.
		vi.setSystemTime(new Date(testBase.getTime() + 60_000));

		const applied = await currentServer().recordVerifications([
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
					narInfoObjectKey(fixtureTenant, metadata.storePathHash)
				)) !== null,
			stagingGone: (await env.BLOBS.head(upload.r2Key)) === null,
			blobState
		}).toStrictEqual({
			applied: 1,
			// A settled upload leaves no residue: the row clears and the staging
			// bytes go.
			verdict: undefined,
			servable: true,
			stagingGone: true,
			// The `verified_at` stamped by the reporter's promote survives, so the
			// settle ran no promote of its own.
			blobState: [{ narHash: metadata.narHash, verifiedAt: promotedAt }]
		});
	});
});
