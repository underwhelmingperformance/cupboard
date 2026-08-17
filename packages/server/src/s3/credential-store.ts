import { bytesToHex } from '@cupboard/nix-store/encoding';
import { type S3CredentialSummary } from '@cupboard/protocol/s3-credentials';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import * as schema from '../db/schema.ts';
import type { SchemaDatabase } from '../do/context.ts';

import {
	type EncryptionKeyset,
	encryptSecret,
	type S3CredentialStore,
	type StoredS3Credential
} from './credentials.ts';

const grantsSchema = z.array(z.string());

/**
 * The {@link S3CredentialStore} backed by the tenant Durable Object's
 * `s3_credential` table. The tenant is the Durable Object itself, so it is
 * supplied rather than stored per row.
 */
export function createS3CredentialStore(
	database: SchemaDatabase,
	tenant: string,
	now: () => Date
): S3CredentialStore {
	return {
		find(accessKeyId): Promise<StoredS3Credential | undefined> {
			const row = database
				.select()
				.from(schema.s3Credentials)
				.where(eq(schema.s3Credentials.accessKeyId, accessKeyId))
				.get();

			if (row === undefined) {
				return Promise.resolve(undefined);
			}

			// Compare as instants: stored timestamps may carry different fractional
			// precision than `now()`, which a string comparison would order wrongly.
			if (
				row.expiresAt !== null &&
				Date.parse(row.expiresAt) <= now().getTime()
			) {
				return Promise.resolve(undefined);
			}

			return Promise.resolve({
				credentialId: row.credentialId,
				secretCiphertext: row.secretCiphertext,
				tenant,
				cache: row.cache,
				grants: grantsSchema.parse(JSON.parse(row.grantsJson)),
				label: row.label
			});
		}
	};
}

export interface CreateS3CredentialInput {
	readonly cache: string;
	readonly grants: readonly string[];
	readonly label: string;
	readonly expiresAt?: string;
}

export interface CreatedS3Credential {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly credentialId: string;
}

function randomToken(byteLength: number): string {
	return bytesToHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/**
 * Provisions a new S3 credential, returning its access key ID and the plaintext
 * secret access key once. The database stores the secret encrypted with the
 * current key in `keyset`.
 */
export async function createS3Credential(
	database: SchemaDatabase,
	keyset: EncryptionKeyset,
	input: CreateS3CredentialInput,
	now: () => Date
): Promise<CreatedS3Credential> {
	const accessKeyId = `CB${randomToken(10).toUpperCase()}`;
	const secretAccessKey = randomToken(24);
	const credentialId = crypto.randomUUID();

	database
		.insert(schema.s3Credentials)
		.values({
			accessKeyId,
			credentialId,
			secretCiphertext: await encryptSecret(keyset, secretAccessKey),
			cache: input.cache,
			grantsJson: JSON.stringify(input.grants),
			label: input.label,
			createdAt: now().toISOString(),
			expiresAt: input.expiresAt
		})
		.run();

	return { accessKeyId, secretAccessKey, credentialId };
}

const uploadGrant = 'upload:commit';

/**
 * Lists the tenant's S3 credentials without exposing secret material.
 */
export function listS3Credentials(
	database: SchemaDatabase
): S3CredentialSummary[] {
	return database
		.select()
		.from(schema.s3Credentials)
		.all()
		.map((row) => ({
			accessKeyId: row.accessKeyId,
			credentialId: row.credentialId,
			cache: row.cache,
			label: row.label,
			writable: grantsSchema
				.parse(JSON.parse(row.grantsJson))
				.includes(uploadGrant),
			createdAt: row.createdAt,
			expiresAt: row.expiresAt ?? undefined
		}));
}

/**
 * Revokes a credential by access key ID and returns the number of rows removed.
 * A missing credential returns zero.
 */
export function revokeS3Credential(
	database: SchemaDatabase,
	accessKeyId: string
): number {
	const removed = database
		.delete(schema.s3Credentials)
		.where(eq(schema.s3Credentials.accessKeyId, accessKeyId))
		.returning({ accessKeyId: schema.s3Credentials.accessKeyId })
		.all();

	return removed.length;
}
