import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CloudflareApi, TokenPolicyInput } from './cloudflare-api.ts';
import {
	ApiTokenResponseError,
	createScopedR2Key,
	R2PermissionGroupsError,
	scopedR2TokenName
} from './r2-token.ts';

const unexpected = (member: string) => (): never => {
	throw new Error(`${member} was not expected`);
};

const baseApi: CloudflareApi = {
	listAccounts: unexpected('listAccounts'),
	ensureR2Bucket: unexpected('ensureR2Bucket'),
	ensureD1Database: unexpected('ensureD1Database'),
	ensureKvNamespace: unexpected('ensureKvNamespace'),
	ensureQueue: unexpected('ensureQueue'),
	d1Query: unexpected('d1Query'),
	d1QueryRows: unexpected('d1QueryRows'),
	getScriptMigrationTag: unexpected('getScriptMigrationTag'),
	uploadScript: unexpected('uploadScript'),
	putQueueConsumer: unexpected('putQueueConsumer'),
	putSchedules: unexpected('putSchedules'),
	putSecret: unexpected('putSecret'),
	listScriptSecrets: unexpected('listScriptSecrets'),
	findZoneId: unexpected('findZoneId'),
	attachCustomDomain: unexpected('attachCustomDomain'),
	listTokenPermissionGroups: unexpected('listTokenPermissionGroups'),
	findApiTokenId: unexpected('findApiTokenId'),
	createApiToken: unexpected('createApiToken'),
	rollApiTokenSecret: unexpected('rollApiTokenSecret')
};

const groups = [
	{ id: 'pg-read', name: 'Workers R2 Storage Bucket Item Read' },
	{ id: 'pg-write', name: 'Workers R2 Storage Bucket Item Write' },
	{ id: 'pg-other', name: 'Workers Scripts Write' }
];

const options = { accountId: 'acc-1', bucketName: 'cupboard-blobs' };

/** A token directory: lookups miss naturally when a name is absent. */
const findIn =
	(tokens: Readonly<Record<string, string>>) =>
	(name: string): Promise<string | undefined> =>
		Promise.resolve(tokens[name]);

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

describe('createScopedR2Key', () => {
	it('creates the bucket, then a token scoped to it, deriving the S3 pair', async () => {
		const created: { name: string; policy: TokenPolicyInput }[] = [];
		const calls: string[] = [];

		const api: CloudflareApi = {
			...baseApi,
			ensureR2Bucket: (name) => {
				calls.push(`bucket:${name}`);
				return Promise.resolve();
			},
			findApiTokenId: findIn({}),
			listTokenPermissionGroups: () => Promise.resolve([...groups]),
			createApiToken: (name, policy) => {
				calls.push('token');
				created.push({ name, policy });
				return Promise.resolve({ id: 'token-id', value: 'token-value' });
			}
		};

		const credentials = await createScopedR2Key(api, options);

		expect({ credentials, created, calls }).toStrictEqual({
			credentials: {
				accessKeyId: 'token-id',
				secretAccessKey: sha256('token-value')
			},
			created: [
				{
					name: scopedR2TokenName('cupboard-blobs'),
					policy: {
						permissionGroupIds: ['pg-read', 'pg-write'],
						resources: {
							'com.cloudflare.edge.r2.bucket.acc-1_default_cupboard-blobs': '*'
						}
					}
				}
			],
			calls: ['bucket:cupboard-blobs', 'token']
		});
	});

	it('rolls the existing token on a re-deploy instead of creating another', async () => {
		const rolled: string[] = [];

		const api: CloudflareApi = {
			...baseApi,
			ensureR2Bucket: () => Promise.resolve(),
			findApiTokenId: findIn({
				[scopedR2TokenName('cupboard-blobs')]: 'existing-id'
			}),
			rollApiTokenSecret: (tokenId) => {
				rolled.push(tokenId);
				return Promise.resolve('rolled-value');
			}
		};

		const credentials = await createScopedR2Key(api, options);

		expect({ credentials, rolled }).toStrictEqual({
			credentials: {
				accessKeyId: 'existing-id',
				secretAccessKey: sha256('rolled-value')
			},
			rolled: ['existing-id']
		});
	});

	it('fails with the missing permission groups named', async () => {
		const api: CloudflareApi = {
			...baseApi,
			ensureR2Bucket: () => Promise.resolve(),
			findApiTokenId: findIn({}),
			listTokenPermissionGroups: () =>
				Promise.resolve([{ id: 'pg-other', name: 'Workers Scripts Write' }])
		};

		await expect(createScopedR2Key(api, options)).rejects.toBeInstanceOf(
			R2PermissionGroupsError
		);
	});

	it('rejects a token response without a value', async () => {
		const api: CloudflareApi = {
			...baseApi,
			ensureR2Bucket: () => Promise.resolve(),
			findApiTokenId: findIn({}),
			listTokenPermissionGroups: () => Promise.resolve([...groups]),
			createApiToken: () => Promise.resolve({ id: 'token-id', value: '' })
		};

		await expect(createScopedR2Key(api, options)).rejects.toStrictEqual(
			new ApiTokenResponseError()
		);
	});
});
