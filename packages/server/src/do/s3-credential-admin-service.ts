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
 * The admin operations behind the `s3Credentials` contract: provisioning,
 * listing and revoking the S3 endpoint's credentials. The secret access key is
 * generated, encrypted under the Worker key and returned only at creation.
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
		// Confirm the endpoint is configured before generating any secret, so an
		// unconfigured deployment answers with a clear error instead of minting a
		// credential it cannot seal.
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
		const wasPresent = listS3Credentials(this.context.db).some(
			(credential) => credential.accessKeyId === accessKeyId
		);
		revokeS3Credential(this.context.db, accessKeyId);
		return { revoked: wasPresent };
	}
}
