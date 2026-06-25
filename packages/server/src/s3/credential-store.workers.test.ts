import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	currentServer,
	resetTestServer,
	useTestServer
} from '../test-support.ts';

import { createS3CredentialStore } from './credential-store.ts';

const now = new Date('2026-06-01T00:00:00.000Z');

async function findWithExpiry(
	accessKeyId: string,
	expiresAt: string | undefined
): Promise<boolean> {
	const credential = await runInDurableObject(
		currentServer(),
		(_instance, state) => {
			const database = drizzle(state.storage, { schema });
			database
				.insert(schema.s3Credentials)
				.values({
					accessKeyId,
					credentialId: 'cred-1',
					secretCiphertext: 'ciphertext',
					cache: '',
					grantsJson: '[]',
					label: 'test',
					createdAt: '2026-01-01T00:00:00.000Z',
					expiresAt
				})
				.run();

			return createS3CredentialStore(database, 'v1', () => now).find(
				accessKeyId
			);
		}
	);

	return credential !== undefined;
}

describe('createS3CredentialStore find expiry', () => {
	beforeEach(resetTestServer);

	it.each([
		{
			id: 'CBFUTURE',
			name: 'an unexpired credential',
			expiresAt: '2026-12-31T00:00:00.000Z',
			resolves: true
		},
		{
			id: 'CBNONE',
			name: 'a never-expiring credential',
			expiresAt: undefined,
			resolves: true
		},
		{
			id: 'CBPAST',
			name: 'an expired credential',
			expiresAt: '2026-01-31T00:00:00.000Z',
			resolves: false
		}
	])('resolves $name: $resolves', async ({ id, expiresAt, resolves }) => {
		await useTestServer(`s3-cred-store-${id.toLowerCase()}`);
		// Trigger the migration so the credential table exists.
		await currentServer().fetch(new Request('https://do.invalid/pubkey'));

		expect(await findWithExpiry(id, expiresAt)).toBe(resolves);
	});
});
