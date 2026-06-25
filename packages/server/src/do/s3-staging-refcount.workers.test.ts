import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { pendingUploads } from '../db/schema.ts';
import { narObjectKey } from '../http/http.ts';
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
describe('S3 staging object reference counting', () => {
	beforeEach(resetTestServer);

	it('keeps a shared staging object until the last live upload settles', async () => {
		await provisionNamedTenant('staging-refcount');

		await runInDurableObject(
			testServerFor('staging-refcount'),
			async (instance) => {
				const { context } = instance;
				const r2Key = 'staging/s3/shared.nar.zst';

				expect(r2Key).not.toBe(narObjectKey(narHash));

				await context.env.BLOBS.put(r2Key, new Uint8Array([1, 2, 3]));

				const now = new Date().toISOString();
				const row = (id: string) => ({
					id,
					cache: '',
					narHash,
					r2Key,
					expectedSize: 3,
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

				await uploadState.markUploadTerminal('a', r2Key, narHash, 'servable');
				expect(await context.env.BLOBS.head(r2Key)).not.toBeNull();

				await uploadState.markUploadTerminal('b', r2Key, narHash, 'servable');
				expect(await context.env.BLOBS.head(r2Key)).toBeNull();
			}
		);
	});
});
