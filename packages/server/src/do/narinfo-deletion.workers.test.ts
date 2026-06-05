import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { narInfoDeletions } from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import {
	authorisedFetch,
	initialise,
	resetTestServer,
	testServerFor,
	useTestServer
} from '../test-support.ts';

const selectDeletions = 'SELECT cache, store_path_hash FROM narinfo_deletion';

describe('narinfo deletion queue', () => {
	beforeEach(resetTestServer);

	it('flushes independent pending deletions for one hash across caches', async () => {
		await useTestServer('narinfo-deletion-caches');
		const token = await initialise();
		const hash = '0'.repeat(32);
		const narHash = 'sha256:nar';
		const createdAt = '2026-01-01T00:00:00.000Z';

		await runInDurableObject(
			testServerFor('narinfo-deletion-caches'),
			(_instance, state) => {
				drizzle(state.storage, { schema: { narInfoDeletions } })
					.insert(narInfoDeletions)
					.values([
						{ cache: '', storePathHash: hash, narHash, createdAt },
						{ cache: 'builds', storePathHash: hash, narHash, createdAt }
					])
					.run();
			}
		);

		await env.BLOBS.put(narInfoObjectKey(hash), 'default narinfo');
		await env.BLOBS.put(narInfoObjectKey(hash, 'builds'), 'builds narinfo');

		const response = await authorisedFetch('/gc', token, { method: 'POST' });
		expect(response.status).toBe(StatusCodes.OK);

		const remaining = await runInDurableObject(
			testServerFor('narinfo-deletion-caches'),
			(_instance, state) => state.storage.sql.exec(selectDeletions).toArray()
		);

		const defaultObject = await env.BLOBS.head(narInfoObjectKey(hash));
		const namedObject = await env.BLOBS.head(narInfoObjectKey(hash, 'builds'));

		expect({
			defaultObjectGone: defaultObject === null,
			namedObjectGone: namedObject === null,
			remaining
		}).toStrictEqual({
			defaultObjectGone: true,
			namedObjectGone: true,
			remaining: []
		});
	});
});
