import { startCapture } from '@cupboard/logger/testing';
import {
	nixSha256HashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import { r2ObjectKeySchema } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import { s3TenantStagingPrefix } from '../s3/staging.ts';
import {
	clearBlobStorage,
	currentServer,
	initialise,
	negotiateUploads,
	resetTestServer,
	runGcResult,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

// A push credential is scoped to `staging/<pushId>/`, so a client may write keys
// beneath it that it never negotiated. The negotiated keys have pending rows the
// reaper owns; reconciliation reclaims the rest once they age past the upload
// grace. The harness fakes `Date` at a fixed epoch but R2 stamps
// `R2Object.uploaded` from the real wall clock, so these tests read the real time
// back from a probe object and move the garbage collector's clock relative to it.

const uploadGraceMs = 15 * 60 * 1000;

// The real wall-clock instant R2 stamps onto an object written now, recovered
// past the harness's faked `Date`.
async function realUploadInstant(): Promise<number> {
	await env.BLOBS.put('probe/now', new Uint8Array([0]));
	const head = await env.BLOBS.head('probe/now');
	await env.BLOBS.delete('probe/now');

	if (head === null) {
		throw new Error('probe object vanished');
	}

	return head.uploaded.getTime();
}

describe('orphan staging reconciliation', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	it('reclaims an un-negotiated staging object and spares the negotiated one', async () => {
		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		const token = await initialise();
		const nar = await verifiableNar('orphan-tracked');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		const negotiation = await negotiateUploads(token, [metadata]);
		const decision = negotiation.uploads[0];

		if (decision?.action !== 'upload') {
			throw new Error('expected an upload decision for a fresh nar');
		}

		const trackedKey = decision.r2Key;
		const pushPrefix = trackedKey.slice(0, trackedKey.lastIndexOf('/') + 1);
		const orphanKey = `${pushPrefix}un-negotiated.nar.zst`;

		await env.BLOBS.put(trackedKey, nar.narBytes);
		await env.BLOBS.put(orphanKey, new Uint8Array([1, 2, 3]));

		const result = await runGcResult();

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			trackedPresent: (await env.BLOBS.head(trackedKey)) !== null,
			orphanPresent: (await env.BLOBS.head(orphanKey)) !== null
		}).toStrictEqual({
			orphanStagingDeleted: 1,
			trackedPresent: true,
			orphanPresent: false
		});
	});

	it('spares an untracked staging object still within the upload grace', async () => {
		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + 60_000));

		const orphanKey = 'staging/recent-push/recent.nar.zst';
		await env.BLOBS.put(orphanKey, new Uint8Array([1, 2, 3]));

		const result = await runGcResult();

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			orphanPresent: (await env.BLOBS.head(orphanKey)) !== null
		}).toStrictEqual({ orphanStagingDeleted: 0, orphanPresent: true });
	});

	it("does not reclaim another tenant's S3 staging object", async () => {
		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		await initialise();
		const currentPrefix = s3TenantStagingPrefix(
			tenantIdSchema.parse(fixtureTenant)
		);
		const foreignPrefix = s3TenantStagingPrefix(
			tenantIdSchema.parse('another-tenant')
		);
		const currentKey = `${currentPrefix}_default/current.nar.zst`;
		const foreignKey = `${foreignPrefix}_default/foreign.nar.zst`;
		await env.BLOBS.put(currentKey, new Uint8Array([1]));
		await env.BLOBS.put(foreignKey, new Uint8Array([2]));

		const result = await runGcResult();

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			currentPresent: (await env.BLOBS.head(currentKey)) !== null,
			foreignPresent: (await env.BLOBS.head(foreignKey)) !== null
		}).toStrictEqual({
			orphanStagingDeleted: 1,
			currentPresent: false,
			foreignPresent: true
		});
	});

	it('keeps an expired upload key that a live sibling still references', async () => {
		await initialise();
		const tenant = tenantIdSchema.parse(fixtureTenant);
		const sharedKey = r2ObjectKeySchema.parse(
			`${s3TenantStagingPrefix(tenant)}_default/shared.nar.zst`
		);
		const hash = nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`);
		await env.BLOBS.put(sharedKey, new Uint8Array([1, 2, 3]));

		await runInDurableObject(currentServer(), (instance) => {
			const row = (
				id: string,
				verdict: typeof schema.pendingUploads.$inferInsert.verdict
			): typeof schema.pendingUploads.$inferInsert => ({
				id: uploadIdSchema.parse(id),
				cache: '',
				narHash: hash,
				r2Key: sharedKey,
				metadataJson: '{}',
				createdAt: isoTimestampSchema.parse('1970-01-01T00:00:00.000Z'),
				expiresAt: isoTimestampSchema.parse('1970-01-01T00:00:00.000Z'),
				verdict
			});

			instance.context.db
				.insert(schema.pendingUploads)
				.values([row('expired', undefined), row('live', 'pending')])
				.run();
		});

		const result = await runGcResult();
		const live = await runInDurableObject(currentServer(), (instance) =>
			instance.context.db
				.select({ id: schema.pendingUploads.id })
				.from(schema.pendingUploads)
				.where(eq(schema.pendingUploads.id, uploadIdSchema.parse('live')))
				.get()
		);

		expect({
			pendingUploadsDeleted: result.pendingUploadsDeleted,
			sharedPresent: (await env.BLOBS.head(sharedKey)) !== null,
			live
		}).toStrictEqual({
			pendingUploadsDeleted: 1,
			sharedPresent: true,
			live: { id: 'live' }
		});
	});

	it('caps the reclaim per run and leaves the overflow for the next run', async () => {
		const perRunCap = 1000;
		const total = perRunCap + 1;

		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		await Promise.all(
			Array.from({ length: total }, (_unused, index) =>
				env.BLOBS.put(
					`staging/flood/${String(index)}.nar.zst`,
					new Uint8Array([1])
				)
			)
		);

		const capture = startCapture();

		let result;
		try {
			result = await runGcResult();
		} finally {
			capture.stop();
		}

		const remaining = await env.BLOBS.list({ prefix: 'staging/flood/' });

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			remaining: remaining.objects.length,
			warnedAboutCap: capture.logs.some(
				(entry) =>
					entry.message === 'orphan staging reclaim hit the per-run cap'
			)
		}).toStrictEqual({
			orphanStagingDeleted: perRunCap,
			remaining: total - perRunCap,
			warnedAboutCap: true
		});
	});
});
