import { bytesToBase64 } from '@cupboard/nix-store/encoding';
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

	// The signed-header and not-hoisted assertions are the R2 contract: R2 ignores
	// a query-hoisted checksum and rejects an unsigned one. The pinned signature is
	// the deterministic SigV4 output for these fixed inputs, so a change in how the
	// URL is signed fails here.
	it('signs a PUT with the checksum as a signed header, not hoisted', async () => {
		const checksum = new Uint8Array(32).fill(7);
		const url = new URL(
			await new R2Presigner(options).presignPutUrl({
				key,
				checksumSha256: bytesToBase64(checksum),
				expiresSeconds: 900
			})
		);

		expect({
			host: url.host,
			pathname: url.pathname,
			algorithm: url.searchParams.get('X-Amz-Algorithm'),
			credential: url.searchParams.get('X-Amz-Credential'),
			expires: url.searchParams.get('X-Amz-Expires'),
			signedHeaders: url.searchParams.get('X-Amz-SignedHeaders'),
			checksumHoisted: url.searchParams.has('x-amz-checksum-sha256'),
			signature: url.searchParams.get('X-Amz-Signature')
		}).toStrictEqual({
			host: 'test-account-id.r2.cloudflarestorage.com',
			pathname: objectPath,
			algorithm: 'AWS4-HMAC-SHA256',
			credential: 'test-access-key-id/20260528/auto/s3/aws4_request',
			expires: '900',
			signedHeaders: 'host;x-amz-checksum-sha256',
			checksumHoisted: false,
			signature:
				'494e9aaa0d137e6c80a31f55fce61f7e3a7c9263e025c2e84053d2afb5dc839b'
		});
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
