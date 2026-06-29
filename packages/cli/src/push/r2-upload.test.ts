import { type PushCredential } from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import { awsCredentials } from './r2-upload.ts';

const credential: PushCredential = {
	pushId: 'push-1',
	accessKeyId: 'access-key',
	secretAccessKey: 'secret-key',
	sessionToken: 'session-token',
	endpoint: 'https://acct.r2.cloudflarestorage.com',
	bucket: 'cupboard-blobs',
	expiresAt: '2026-06-29T12:10:00.000Z'
};

describe('awsCredentials', () => {
	it('maps a push credential to the S3 client identity with an expiry', () => {
		expect(awsCredentials(credential)).toStrictEqual({
			accessKeyId: 'access-key',
			secretAccessKey: 'secret-key',
			sessionToken: 'session-token',
			expiration: new Date('2026-06-29T12:10:00.000Z')
		});
	});
});
