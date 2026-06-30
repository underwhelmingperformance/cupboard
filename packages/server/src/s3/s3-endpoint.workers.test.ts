import { AwsClient } from 'aws4fetch';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	currentServer,
	resetTestServer,
	useTestServer
} from '../test-support.ts';

import {
	createEncryptionKeyset,
	encryptSecret,
	importEncryptionKey
} from './credentials.ts';

const bucket = 'v1';
const accessKeyId = 'AKIDTEST';
const secretAccessKey = 'test-secret-access-key-value';

function s3Request(headers: HeadersInit): Request {
	return new Request(`https://s3.example.com/${bucket}/nix-cache-info`, {
		method: 'GET',
		headers
	});
}

async function seedCredential(): Promise<void> {
	const keyset = createEncryptionKeyset(
		await importEncryptionKey(env.S3_SECRET_KEY)
	);
	const ciphertext = await encryptSecret(keyset, secretAccessKey);

	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema })
			.insert(schema.s3Credentials)
			.values({
				accessKeyId,
				credentialId: 'cred-1',
				secretCiphertext: ciphertext,
				cache: '',
				grantsJson: JSON.stringify(['upload:commit']),
				label: 'test',
				createdAt: '2026-01-01T00:00:00.000Z',
				expiresAt: undefined
			})
			.run();
	});
}

describe('S3 endpoint mount', () => {
	beforeEach(resetTestServer);

	it('rejects an unsigned request with 403', async () => {
		await useTestServer('s3-mount-unsigned');

		const response = await currentServer().fetch(
			s3Request({ 'x-cupboard-s3': '1' })
		);
		expect(response.status).toBe(403);
		expect(await response.text()).toContain('AccessDenied');
	});

	it('serves nix-cache-info to a signed request with a valid credential', async () => {
		await useTestServer('s3-mount-signed');
		// Trigger the migration so the credential table exists before seeding.
		await currentServer().fetch(new Request('https://do.invalid/pubkey'));
		await seedCredential();

		const signer = new AwsClient({
			accessKeyId,
			secretAccessKey,
			service: 's3',
			region: 'auto'
		});
		const signed = await signer.sign(
			`https://s3.example.com/${bucket}/nix-cache-info`,
			{ method: 'GET', aws: { service: 's3', region: 'auto' } }
		);

		const headers = new Headers(signed.headers);
		headers.set('x-cupboard-s3', '1');

		const response = await currentServer().fetch(s3Request(headers));
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('StoreDir: /nix/store');
	});

	it('rejects a tampered signature with 403', async () => {
		await useTestServer('s3-mount-tampered');
		await currentServer().fetch(new Request('https://do.invalid/pubkey'));
		await seedCredential();

		const signer = new AwsClient({
			accessKeyId,
			secretAccessKey: 'the-wrong-secret',
			service: 's3',
			region: 'auto'
		});
		const signed = await signer.sign(
			`https://s3.example.com/${bucket}/nix-cache-info`,
			{ method: 'GET', aws: { service: 's3', region: 'auto' } }
		);

		const headers = new Headers(signed.headers);
		headers.set('x-cupboard-s3', '1');

		const response = await currentServer().fetch(s3Request(headers));
		expect(response.status).toBe(403);
		expect(await response.text()).toContain('SignatureDoesNotMatch');
	});
});
