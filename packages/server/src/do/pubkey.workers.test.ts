import { keyRotateResponseSchema } from '@cupboard/protocol/keys';
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
		const beforeKeys = beforeBody.trim().split('\n');

		const rotated = await authorisedWorkerFetch('/keys/rotate', token, {
			method: 'POST'
		});
		const rotatedBody = keyRotateResponseSchema.parse(await rotated.json());

		const after = await readFetch('/pubkey');
		const afterBody = await after.text();

		expect({
			rotateStatus: rotated.status,
			keys: afterBody.trim().split('\n'),
			cacheControl: after.headers.get('cache-control')
		}).toStrictEqual({
			rotateStatus: StatusCodes.OK,
			keys: [...beforeKeys, rotatedBody.rotated.key.publicKey],
			cacheControl: 'no-cache'
		});
	});
});
