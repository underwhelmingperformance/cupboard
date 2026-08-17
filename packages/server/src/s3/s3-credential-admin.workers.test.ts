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
	fileHash,
	narBytes,
	resetTestServer,
	useTestServer
} from '../test-support.ts';

const bucket = 'v1';

async function s3Status(
	accessKeyId: string,
	secretAccessKey: string,
	key = 'nix-cache-info',
	method = 'GET',
	body?: Uint8Array
): Promise<number> {
	const signer = new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: 's3',
		region: 'auto'
	});
	const url = `https://s3.example.com/${bucket}/${key}`;
	const signed = await signer.sign(url, {
		method,
		body,
		aws: { service: 's3', region: 'auto' }
	});
	const headers = new Headers(signed.headers);
	headers.set('x-cupboard-s3', '1');

	const response = await currentServer().fetch(
		new Request(signed, { headers })
	);
	return response.status;
}

describe('S3 credential admin', () => {
	beforeEach(resetTestServer);

	it('provisions a credential that authenticates a request, then rejects it after revocation', async () => {
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

		expect(await s3Status(created.accessKeyId, created.secretAccessKey)).toBe(
			StatusCodes.OK
		);

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

		expect(await s3Status(created.accessKeyId, created.secretAccessKey)).toBe(
			StatusCodes.FORBIDDEN
		);
	});

	it('rejects a credential scoped to the reserved nar name', async () => {
		await useTestServer('s3-cred-reserved-cache');
		const { token } = await bootstrap();

		const response = await authorisedFetch('/s3-credentials', token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ cache: 'nar', label: 'ambiguous', writable: true })
		});

		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
	});

	it('revokes credentials scoped to a deleted cache', async () => {
		await useTestServer('s3-cred-cache-delete');
		const { token } = await bootstrap();
		const cache = 'builds';

		const createdCache = await authorisedFetch(`/caches/${cache}`, token, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ priority: 40 })
		});
		expect(createdCache.status).toBe(StatusCodes.OK);

		const provisioned = await authorisedFetch('/s3-credentials', token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ cache, label: 'nixbuild', writable: true })
		});
		const credential = s3CredentialCreateResponseSchema.parse(
			await provisioned.json()
		);

		expect(
			await s3Status(
				credential.accessKeyId,
				credential.secretAccessKey,
				`${cache}/nix-cache-info`
			)
		).toBe(StatusCodes.OK);

		const removed = await authorisedFetch(`/caches/${cache}`, token, {
			method: 'DELETE'
		});
		expect(removed.status).toBe(StatusCodes.OK);

		const statuses = await Promise.all([
			s3Status(
				credential.accessKeyId,
				credential.secretAccessKey,
				`${cache}/nix-cache-info`
			),
			s3Status(
				credential.accessKeyId,
				credential.secretAccessKey,
				`${cache}/nar/${fileHash.toString().slice('sha256:'.length)}.nar.zst`,
				'PUT',
				narBytes
			)
		]);
		expect(statuses).toStrictEqual([
			StatusCodes.FORBIDDEN,
			StatusCodes.FORBIDDEN
		]);
	});
});
