import {
	s3CredentialCreateResponseSchema,
	s3CredentialListResponseSchema,
	s3CredentialRevokeResponseSchema
} from '@cupboard/protocol/s3-credentials';
import { AwsClient } from 'aws4fetch';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	authorisedFetch,
	bootstrap,
	currentServer,
	resetTestServer,
	useTestServer
} from '../test-support.ts';

const bucket = 'v1';

async function cacheInfoStatus(
	accessKeyId: string,
	secretAccessKey: string
): Promise<number> {
	const signer = new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: 's3',
		region: 'auto'
	});
	const url = `https://s3.example.com/${bucket}/nix-cache-info`;
	const signed = await signer.sign(url, {
		method: 'GET',
		aws: { service: 's3', region: 'auto' }
	});
	const headers = new Headers(signed.headers);
	headers.set('x-cupboard-s3', '1');

	const response = await currentServer().fetch(
		new Request(url, { method: 'GET', headers })
	);
	return response.status;
}

describe('S3 credential admin', () => {
	beforeEach(resetTestServer);

	it('provisions a credential that works, then revokes it', async () => {
		await useTestServer('s3-cred-admin');
		const { token } = await bootstrap();

		const provisioned = await authorisedFetch('/s3-credentials', token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ cache: '', label: 'nixbuild', writable: true })
		});
		expect(provisioned.status).toBe(StatusCodes.OK);

		const created = s3CredentialCreateResponseSchema.parse(
			await provisioned.json()
		);
		expect(created.accessKeyId).toMatch(/^CB/);
		expect(created.label).toBe('nixbuild');

		expect(
			await cacheInfoStatus(created.accessKeyId, created.secretAccessKey)
		).toBe(StatusCodes.OK);

		const listResponse = await authorisedFetch('/s3-credentials', token);
		const list = s3CredentialListResponseSchema.parse(
			await listResponse.json()
		);
		expect(
			list.credentials.map((credential) => credential.accessKeyId)
		).toContain(created.accessKeyId);

		const revokeResponse = await authorisedFetch(
			`/s3-credentials/${created.accessKeyId}`,
			token,
			{ method: 'DELETE' }
		);
		expect(
			s3CredentialRevokeResponseSchema.parse(await revokeResponse.json())
				.revoked
		).toBe(true);

		expect(
			await cacheInfoStatus(created.accessKeyId, created.secretAccessKey)
		).toBe(StatusCodes.FORBIDDEN);
	});
});
