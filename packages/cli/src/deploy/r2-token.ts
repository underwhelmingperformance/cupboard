import { createHash } from 'node:crypto';

import { APIError } from 'cloudflare';

import { CliError } from '../errors.ts';

import type { CloudflareApi } from './cloudflare-api.ts';
import type { CloudflareAccountId } from './identifiers.ts';
import {
	r2AccessKeyIdSchema,
	type R2Credentials,
	r2SecretAccessKeySchema
} from './r2-credentials.ts';

/** The deploy credential may not manage account API tokens. */
export class TokenManagementNotPermittedError extends CliError {
	constructor(options: { readonly cause: unknown }) {
		super(
			'The deploy credential cannot manage API tokens. Grant it ' +
				'"Account API Tokens: Edit", or enter an existing R2 key pair.',
			options
		);
		this.name = 'TokenManagementNotPermittedError';
	}
}

/** The account's token permission groups are missing the R2 object pair. */
export class R2PermissionGroupsError extends CliError {
	constructor(public readonly wanted: readonly string[]) {
		super(`Could not find the token permission groups: ${wanted.join(', ')}`);
		this.name = 'R2PermissionGroupsError';
	}
}

/** Cloudflare answered a token request without the id or secret value. */
export class ApiTokenResponseError extends CliError {
	constructor(
		public readonly hasId: boolean,
		public readonly hasValue: boolean
	) {
		super('Cloudflare returned an API token without an id or value');
		this.name = 'ApiTokenResponseError';
	}
}

// Write alone: a push uploads with a write-only credential and the deploy
// probe writes too, so the token never needs to read. Object serving goes
// through the R2 bucket binding, not this S3 key.
const writePermissionGroups = ['Workers R2 Storage Bucket Item Write'];

/** The deterministic token name a deployment owns for a bucket. */
export function scopedR2TokenName(bucketName: string): string {
	return `cupboard-r2-${bucketName}`;
}

/**
 * Creates (or, on a re-deploy, rolls) the account-owned API token that backs
 * the cache's R2 credentials: write-only on exactly one bucket. The bucket must
 * already exist; the caller creates it, visibly, first. The S3 pair is derived
 * from the token; nothing is stored anywhere except as Worker secrets, and
 * re-running rotates the secret.
 */
export async function createScopedR2Key(
	api: CloudflareApi,
	options: {
		readonly accountId: CloudflareAccountId;
		readonly bucketName: string;
	}
): Promise<R2Credentials> {
	try {
		const name = scopedR2TokenName(options.bucketName);
		const existingId = await api.findApiTokenId(name);

		if (existingId !== undefined) {
			const value = await api.rollApiTokenSecret(existingId);

			return pairFrom(existingId, value);
		}

		const groups = await api.listTokenPermissionGroups();
		const ids: string[] = [];

		for (const groupName of writePermissionGroups) {
			const id = groups.find((group) => group.name === groupName)?.id;

			if (id === undefined) {
				throw new R2PermissionGroupsError(writePermissionGroups);
			}

			ids.push(id);
		}

		const created = await api.createApiToken(name, {
			permissionGroupIds: ids,
			resources: {
				[`com.cloudflare.edge.r2.bucket.${options.accountId}_default_${options.bucketName}`]:
					'*'
			}
		});

		return pairFrom(created.id, created.value);
	} catch (error) {
		if (
			error instanceof APIError &&
			(error.status === 403 || error.status === 401)
		) {
			throw new TokenManagementNotPermittedError({ cause: error });
		}

		throw error;
	}
}

/**
 * An R2 S3 credential pair from an API token: the access key id is the token
 * id, and the secret is the hex SHA-256 of the token's value.
 */
function pairFrom(id: string, value: string): R2Credentials {
	if (id === '' || value === '') {
		throw new ApiTokenResponseError(id !== '', value !== '');
	}

	return {
		accessKeyId: r2AccessKeyIdSchema.parse(id),
		secretAccessKey: r2SecretAccessKeySchema.parse(
			createHash('sha256').update(value).digest('hex')
		)
	};
}
