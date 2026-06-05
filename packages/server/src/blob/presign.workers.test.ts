import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { R2Presigner } from './presign.ts';

const options = {
	accountId: 'test-account-id',
	accessKeyId: 'test-access-key-id',
	secretAccessKey: 'test-secret-access-key',
	bucketName: 'cupboard-blobs',
	key: 'nar/sha256:1m5g07jiajz7135sj3ap8h30s0n24nc6a2q3gsraqj3pfi0jw65l.nar.zst'
};

describe('R2Presigner', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-28T00:00:00.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('produces a stable presigned PUT URL', async () => {
		const presigner = new R2Presigner(options);
		const url = new URL(
			await presigner.presignPutUrl({
				key: options.key,
				checksumSha256: base64(new Uint8Array(32).fill(7)),
				expiresSeconds: 900
			})
		);
		const parameters = Object.fromEntries(url.searchParams);

		expect({
			host: url.host,
			pathname: url.pathname,
			parameters: {
				'X-Amz-Algorithm': parameters['X-Amz-Algorithm'],
				'X-Amz-Credential': parameters['X-Amz-Credential'],
				'X-Amz-Expires': parameters['X-Amz-Expires'],
				'X-Amz-SignedHeaders': parameters['X-Amz-SignedHeaders'],
				'x-amz-checksum-sha256': parameters['x-amz-checksum-sha256']
			},
			hasSignature: url.searchParams.has('X-Amz-Signature')
		}).toStrictEqual({
			host: 'test-account-id.r2.cloudflarestorage.com',
			pathname:
				'/cupboard-blobs/nar/sha256%3A1m5g07jiajz7135sj3ap8h30s0n24nc6a2q3gsraqj3pfi0jw65l.nar.zst',
			parameters: {
				'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
				'X-Amz-Credential': 'test-access-key-id/20260528/auto/s3/aws4_request',
				'X-Amz-Expires': '900',
				'X-Amz-SignedHeaders': 'host',
				'x-amz-checksum-sha256': 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc='
			},
			hasSignature: true
		});
	});
});

function base64(bytes: Uint8Array): string {
	return btoa(String.fromCodePoint(...bytes));
}
