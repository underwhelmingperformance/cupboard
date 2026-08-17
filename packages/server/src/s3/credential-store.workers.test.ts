import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	currentServer,
	resetTestServer,
	useTestServer
} from '../test-support.ts';

import {
	createS3CredentialStore,
	revokeS3Credential
} from './credential-store.ts';
import type { StoredS3Credential } from './credentials.ts';

const now = new Date('2026-06-01T00:00:00.000Z');

async function insertAndFindCredential(
	accessKeyId: string,
	expiresAt: string | undefined
): Promise<StoredS3Credential | undefined> {
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

	return credential;
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
		},
		{
			id: 'CBNOW',
			name: 'a credential at its expiry instant',
			expiresAt: now.toISOString(),
			resolves: false
		}
	])('resolves $name: $resolves', async ({ id, expiresAt, resolves }) => {
		await useTestServer(`s3-cred-store-${id.toLowerCase()}`);
		// Trigger the migration so the credential table exists.
		await currentServer().fetch(new Request('https://do.invalid/pubkey'));

		const credential = await insertAndFindCredential(id, expiresAt);
		expect(credential !== undefined).toBe(resolves);
	});
});

describe('revokeS3Credential', () => {
	beforeEach(resetTestServer);

	it('reports whether a credential was present', async () => {
		await useTestServer('s3-cred-store-revoke');
		await currentServer().fetch(new Request('https://do.invalid/pubkey'));

		const outcome = await runInDurableObject(
			currentServer(),
			(_instance, state) => {
				const database = drizzle(state.storage, { schema });
				database
					.insert(schema.s3Credentials)
					.values({
						accessKeyId: 'CBPRESENT',
						credentialId: 'cred-1',
						secretCiphertext: 'ciphertext',
						cache: '',
						grantsJson: '[]',
						label: 'test',
						createdAt: '2026-01-01T00:00:00.000Z',
						expiresAt: undefined
					})
					.run();

				return {
					present: revokeS3Credential(database, 'CBPRESENT'),
					absent: revokeS3Credential(database, 'CBMISSING')
				};
			}
		);

		expect(outcome).toStrictEqual({ present: 1, absent: 0 });
	});
});
