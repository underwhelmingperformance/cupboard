import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { R2Presigner } from './presign.ts';

const options = {
	accountId: 'test-account-id',
	accessKeyId: 'test-access-key-id',
	secretAccessKey: 'test-secret-access-key',
	bucketName: 'cupboard-blobs'
};
const key =
	'nar/sha256:1m5g07jiajz7135sj3ap8h30s0n24nc6a2q3gsraqj3pfi0jw65l.nar.zst';
const objectPath =
	'/cupboard-blobs/nar/sha256:1m5g07jiajz7135sj3ap8h30s0n24nc6a2q3gsraqj3pfi0jw65l.nar.zst';

describe('R2Presigner', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-28T00:00:00.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('signs a HEAD probe', async () => {
		const url = new URL(await new R2Presigner(options).presignHeadUrl(key, 60));

		expect({
			pathname: url.pathname,
			expires: url.searchParams.get('X-Amz-Expires'),
			signedHeaders: url.searchParams.get('X-Amz-SignedHeaders'),
			signature: url.searchParams.get('X-Amz-Signature')
		}).toStrictEqual({
			pathname: objectPath,
			expires: '60',
			signedHeaders: 'host',
			signature:
				'26a3877f794d7610e72cab0cb72483700cc51b2142d68a45927e7d7b539f9c08'
		});
	});
});
