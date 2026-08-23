import { afterEach, describe, expect, it, vi } from 'vitest';

import { R2Presigner } from './presign.ts';

const options = {
	accountId: 'test-account-id',
	accessKeyId: 'test-access-key-id',
	secretAccessKey: 'test-secret-access-key',
	bucketName: 'cupboard-blobs'
};
const now = new Date('2026-05-28T00:00:00.000Z');

describe('R2Presigner', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('sends a header-signed GET to the credential probe key', async () => {
		let request: Request | undefined;
		vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
			request = new Request(input, init);

			return Promise.resolve(new Response(undefined, { status: 404 }));
		});

		const response = await new R2Presigner(options).probeTemporaryCredential(
			now
		);
		const signed = new URL(request?.url ?? '');

		expect({
			status: response.status,
			method: request?.method,
			href: signed.href,
			hasSessionToken: request?.headers.has('x-amz-security-token'),
			hasAuthorization: request?.headers.has('authorization')
		}).toStrictEqual({
			status: 404,
			method: 'GET',
			href: 'https://test-account-id.r2.cloudflarestorage.com/cupboard-blobs/staging/.cupboard-credential-probe/probe',
			hasSessionToken: true,
			hasAuthorization: true
		});
	});
});
