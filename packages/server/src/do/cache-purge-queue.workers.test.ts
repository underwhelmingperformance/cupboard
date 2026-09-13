import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	bootstrap,
	currentServer,
	narHash,
	resetTestServer,
	resolvedCache,
	withoutAlarmArming
} from '../test-support.ts';

import { CachePurgeQueueService } from './cache-purge-queue-service.ts';

describe('cache purge queue', () => {
	beforeEach(resetTestServer);

	// A NAR response stored at the edge before the tag carried the cache is
	// tagged by tenant and hash alone, and it lives for the NAR TTL. A purge
	// queues that tag beside the cache's own so the old response goes too.
	it('queues the per-cache tag and the tenant-wide tag for a retired NAR', async () => {
		await bootstrap();

		const queued = await withoutAlarmArming(() =>
			runInDurableObject(currentServer(), async (instance) => {
				await new CachePurgeQueueService(instance.context).enqueueNars(
					resolvedCache(instance.context),
					[narHash]
				);

				return instance.context.db
					.select({ entriesJson: schema.cachePurgeContinuations.entriesJson })
					.from(schema.cachePurgeContinuations)
					.all()
					.map((row) => JSON.parse(row.entriesJson) as unknown);
			})
		);

		expect(queued).toStrictEqual([
			[
				`nar:${fixtureTenant}:default:${narHash}`,
				`nar:${fixtureTenant}:${narHash}`
			]
		]);
	});
});
