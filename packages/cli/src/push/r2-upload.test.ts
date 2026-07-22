import { type S3ClientConfig } from '@aws-sdk/client-s3';
import { type Options } from '@aws-sdk/lib-storage';
import {
	type ParsedPushCredential,
	pushCredentialSchema
} from '@cupboard/protocol/upload';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { awsCredentials, r2BlobUploader } from './r2-upload.ts';

const mocks = vi.hoisted(() => {
	const done = vi.fn<() => Promise<void>>(() => Promise.resolve());
	const Upload = vi.fn(function MockUpload(_options: Options) {
		return { done };
	});
	const S3Client = vi.fn<(config: S3ClientConfig) => void>();

	return { done, Upload, S3Client };
});

vi.mock('@aws-sdk/client-s3', () => ({ S3Client: mocks.S3Client }));
vi.mock('@aws-sdk/lib-storage', () => ({ Upload: mocks.Upload }));

const credential = pushCredentialSchema.parse({
	pushId: 'push-1',
	accessKeyId: 'access-key',
	secretAccessKey: 'secret-key',
	sessionToken: 'session-token',
	endpoint: 'https://acct.r2.cloudflarestorage.com',
	bucket: 'cupboard-blobs',
	expiresAt: '2026-06-29T12:10:00.000Z'
});

const expectedIdentity = {
	accessKeyId: 'access-key',
	secretAccessKey: 'secret-key',
	sessionToken: 'session-token',
	expiration: new Date('2026-06-29T12:10:00.000Z')
};

describe('awsCredentials', () => {
	it('maps a push credential to the S3 client identity with an expiry', () => {
		expect(awsCredentials(credential)).toStrictEqual(expectedIdentity);
	});
});

describe('r2BlobUploader', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const endpoint = 'https://acct.r2.cloudflarestorage.com';
	const bucket = 'cupboard-blobs';
	const partBytes = 8 * 1024 * 1024;

	it('builds a path-style auto-region S3 client whose credentials resolver renews through the provider', async () => {
		const provider = vi.fn<() => Promise<ParsedPushCredential>>(() =>
			Promise.resolve(credential)
		);

		r2BlobUploader({ endpoint, bucket, provider });

		const [s3Call] = mocks.S3Client.mock.calls;

		if (s3Call === undefined) {
			throw new Error('the S3 client was never constructed');
		}

		const { credentials, ...rest } = s3Call[0];

		if (typeof credentials !== 'function') {
			throw new TypeError('expected a credentials provider function');
		}

		const resolved = await credentials();

		expect({
			rest,
			resolved,
			providerCalls: provider.mock.calls.length
		}).toStrictEqual({
			rest: { endpoint, region: 'auto', forcePathStyle: true },
			resolved: expectedIdentity,
			providerCalls: 1
		});
	});

	it('streams the body to the requested key and awaits the managed upload', async () => {
		const provider = vi.fn<() => Promise<ParsedPushCredential>>(() =>
			Promise.resolve(credential)
		);
		const body = new ReadableStream<Uint8Array>();

		const upload = r2BlobUploader({ endpoint, bucket, provider });
		await upload('staging/push-1/nar.zst', body);

		const [uploadCall] = mocks.Upload.mock.calls;

		if (uploadCall === undefined) {
			throw new Error('the managed upload was never created');
		}

		const { client: _client, ...options } = uploadCall[0];

		expect({ options, doneCalls: mocks.done.mock.calls.length }).toStrictEqual({
			options: {
				params: {
					Bucket: bucket,
					Key: 'staging/push-1/nar.zst',
					Body: body
				},
				partSize: partBytes
			},
			doneCalls: 1
		});
	});
});
