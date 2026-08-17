import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { WritesNotAcceptedError } from '@cupboard/s3/errors';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	currentServer,
	resetTestServer,
	useTestServer
} from '../test-support.ts';

const cache = cacheNameSchema.parse('builds');

describe('CacheMutationGate', () => {
	beforeEach(resetTestServer);

	it('orders teardown cleanup after an active S3 mutation', async () => {
		await useTestServer('cache-mutation-gate-drain');

		await runInDurableObject(currentServer(), async (instance) => {
			const started = Promise.withResolvers<undefined>();
			const release = Promise.withResolvers<undefined>();
			const events: string[] = [];
			const mutation = instance.context.cacheMutations.run(cache, async () => {
				started.resolve(undefined);
				await release.promise;
				events.push('mutation finished');
			});
			await started.promise;

			await instance.context.cacheMutations.block(cache);
			const cleanup = (async () => {
				await instance.context.cacheMutations.waitForIdle(cache);
				events.push('cleanup started');
			})();
			await Promise.resolve();
			expect(events).toStrictEqual([]);

			release.resolve(undefined);
			await Promise.all([mutation, cleanup]);
			expect(events).toStrictEqual(['mutation finished', 'cleanup started']);
			await expect(
				instance.context.cacheMutations.run(cache, () => Promise.resolve())
			).rejects.toThrow(WritesNotAcceptedError);
		});
	});
});
