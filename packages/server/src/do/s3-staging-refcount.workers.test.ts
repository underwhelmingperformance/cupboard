import { DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { uploadIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { pendingUploads } from '../db/schema.ts';
import { narObjectKey, r2ObjectKeySchema } from '../http/http.ts';
import {
	narHash,
	provisionNamedTenant,
	resetTestServer,
	testServerFor
} from '../test-support.ts';

import { UploadStateService } from './upload-state-service.ts';

// An S3 ingest stages a NAR by its file hash, so two concurrent uploads of
// identical content share one staging object. The first to reach a terminal
// verdict must not delete the bytes while a sibling's verify still needs them.
describe('shared S3 staging object lifetime', () => {
	beforeEach(resetTestServer);

	it('keeps a shared staging object until the last live upload settles', async () => {
		await provisionNamedTenant('staging-refcount');

		await runInDurableObject(
			testServerFor('staging-refcount'),
			async (instance) => {
				const { context } = instance;
				const r2Key = r2ObjectKeySchema.parse('staging/s3/shared.nar.zst');

				expect(r2Key).not.toBe(narObjectKey(narHash));

				await context.env.BLOBS.put(r2Key, new Uint8Array([1, 2, 3]));

				const now = isoTimestamp(new Date());
				const row = (id: string): typeof pendingUploads.$inferInsert => ({
					id: uploadIdSchema.parse(id),
					cache: DEFAULT_CACHE,
					narHash,
					r2Key,
					metadataJson: '{}',
					createdAt: now,
					expiresAt: now,
					verdict: 'pending' as const
				});
				context.db
					.insert(pendingUploads)
					.values([row('a'), row('b')])
					.run();

				const uploadState = new UploadStateService(context);

				await uploadState.markUploadTerminal(
					uploadIdSchema.parse('a'),
					r2Key,
					narHash,
					'servable'
				);
				expect(await context.env.BLOBS.head(r2Key)).not.toBeNull();

				await uploadState.markUploadTerminal(
					uploadIdSchema.parse('b'),
					r2Key,
					narHash,
					'servable'
				);
				expect(await context.env.BLOBS.head(r2Key)).toBeNull();
			}
		);
	});
});
