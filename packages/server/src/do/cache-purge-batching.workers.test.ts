// Cloudflare accepts at most 100 operations in one purge request. A caller
// hands `purgeCacheTags` the tags it has, so the split has to happen there.
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { currentServer, initialise, resetTestServer } from '../test-support.ts';
import { CachedTenantReads } from '../test-worker.ts';

describe('cache tag purging', () => {
	it('splits a tag list the platform will not take in one request', async () => {
		await resetTestServer();
		await initialise();
		const purgeTags = vi
			.spyOn(CachedTenantReads.prototype, 'purgeTags')
			.mockResolvedValue(undefined);

		try {
			await runInDurableObject(currentServer(), (instance) =>
				instance.context.purgeCacheTags(
					Array.from({ length: 250 }, (_, index) => `narinfo-${String(index)}`)
				)
			);

			expect(purgeTags.mock.calls.map(([tags]) => tags.length)).toStrictEqual([
				100, 100, 50
			]);
		} finally {
			purgeTags.mockRestore();
		}
	});
});
