// Cloudflare accepts at most 100 operations in one purge request. A caller
// hands `purgeCacheTags` the tags it has, so the split has to happen there.
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { WorkersCachePurgeError } from '../errors.ts';
import { currentServer, initialise, resetTestServer } from '../test-support.ts';
import { CachedTenantReads } from '../test-worker.ts';

describe('cache tag purging', () => {
	it('splits a tag list the platform will not take in one request', async () => {
		await resetTestServer();
		await initialise();
		const purgeTags = vi
			.spyOn(CachedTenantReads.prototype, 'purgeTags')
			.mockResolvedValue({ success: true, errors: [] });

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

	it('rejects with the codes of a purge the platform refuses', async () => {
		await resetTestServer();
		await initialise();
		const purgeTags = vi
			.spyOn(CachedTenantReads.prototype, 'purgeTags')
			.mockResolvedValue({
				success: false,
				errors: [
					{ code: 1134, message: 'Unable to purge, rate limit reached.' }
				]
			});

		try {
			const rejection = await runInDurableObject(
				currentServer(),
				async (instance) => {
					try {
						await instance.context.purgeCacheTags(['narinfo-1']);

						return { isPurgeError: false, codes: [] };
					} catch (error) {
						return error instanceof WorkersCachePurgeError
							? { isPurgeError: true, codes: error.codes }
							: { isPurgeError: false, codes: [] };
					}
				}
			);

			expect(rejection).toStrictEqual({ isPurgeError: true, codes: [1134] });
		} finally {
			purgeTags.mockRestore();
		}
	});
});
