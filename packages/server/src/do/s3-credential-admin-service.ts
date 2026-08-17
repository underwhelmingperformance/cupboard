import {
	type ParsedS3CredentialCreateBody,
	type S3CredentialCreated,
	type S3CredentialListResponse,
	type S3CredentialRevokeResponse
} from '@cupboard/protocol/s3-credentials';

import { S3EndpointNotConfiguredError } from '../errors.ts';
import {
	createS3Credential,
	listS3Credentials,
	revokeS3Credential
} from '../s3/credential-store.ts';
import {
	type EncryptionKeyset,
	loadEncryptionKeyset
} from '../s3/credentials.ts';

import { type ServerContext } from './context.ts';

const uploadGrant = 'upload:commit';

/**
 * Implements the `s3Credentials` contract. Creation generates a secret access
 * key, encrypts it with the current S3 encryption key and returns the plaintext
 * only once.
 */
export class S3CredentialAdminService {
	private keysetPromise: Promise<EncryptionKeyset | undefined> | undefined;

	constructor(private readonly context: ServerContext) {}

	private encryptionKeyset(): Promise<EncryptionKeyset | undefined> {
		this.keysetPromise ??= loadEncryptionKeyset(this.context.env.S3_SECRET_KEY);
		return this.keysetPromise;
	}

	async create(
		body: ParsedS3CredentialCreateBody
	): Promise<S3CredentialCreated> {
		const keyset = await this.encryptionKeyset();
		if (keyset === undefined) {
			throw new S3EndpointNotConfiguredError();
		}

		const created = await createS3Credential(
			this.context.db,
			keyset,
			{
				cache: body.cache,
				grants: body.writable ? [uploadGrant] : [],
				label: body.label,
				expiresAt: body.expiresAt
			},
			() => new Date()
		);

		return {
			credentialId: created.credentialId,
			accessKeyId: created.accessKeyId,
			secretAccessKey: created.secretAccessKey,
			cache: body.cache,
			label: body.label,
			writable: body.writable,
			expiresAt: body.expiresAt
		};
	}

	list(): S3CredentialListResponse {
		return { credentials: listS3Credentials(this.context.db) };
	}

	revoke(accessKeyId: string): S3CredentialRevokeResponse {
		return { revoked: revokeS3Credential(this.context.db, accessKeyId) > 0 };
	}
}
