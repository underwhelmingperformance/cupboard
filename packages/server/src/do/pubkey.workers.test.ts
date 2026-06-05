import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	authorisedWorkerFetch,
	bootstrap,
	fetchPath,
	initialiseViaWorker,
	readFetch,
	resetTestServer
} from '../test-support.ts';

describe('/pubkey serving', () => {
	beforeEach(resetTestServer);

	it('is served no-cache with a strong etag for conditional revalidation', async () => {
		await bootstrap();
		const first = await fetchPath('/pubkey');
		const etag = first.headers.get('etag');
		const conditional = await fetchPath('/pubkey', {
			headers: { 'if-none-match': etag ?? '' }
		});

		expect({
			cacheControl: first.headers.get('cache-control'),
			etagPresent: etag !== null,
			conditionalStatus: conditional.status
		}).toStrictEqual({
			cacheControl: 'no-cache',
			etagPresent: true,
			conditionalStatus: StatusCodes.NOT_MODIFIED
		});
	});

	it('reflects a rotation immediately through the Worker, with no stale copy', async () => {
		const token = await initialiseViaWorker();
		const before = await readFetch('/pubkey');
		const beforeBody = await before.text();
		const beforeLines = beforeBody.trim().split('\n').length;

		const rotated = await authorisedWorkerFetch('/keys/rotate', token, {
			method: 'POST'
		});
		expect(rotated.status).toBe(StatusCodes.OK);

		const after = await readFetch('/pubkey');
		const afterBody = await after.text();

		expect({
			addedKeys: afterBody.trim().split('\n').length - beforeLines,
			cacheControl: after.headers.get('cache-control')
		}).toStrictEqual({ addedKeys: 1, cacheControl: 'no-cache' });
	});
});
