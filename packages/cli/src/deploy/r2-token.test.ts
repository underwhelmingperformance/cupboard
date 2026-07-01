import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { CloudflareApi, TokenPolicyInput } from './cloudflare-api.ts';
import {
	ApiTokenResponseError,
	createScopedR2Key,
	R2PermissionGroupsError,
	scopedR2TokenName
} from './r2-token.ts';

type ApiCall =
	| { readonly method: keyof CloudflareApi }
	| {
			readonly method: 'createApiToken';
			readonly name: string;
			readonly policy: TokenPolicyInput;
	  }
	| { readonly method: 'rollApiTokenSecret'; readonly tokenId: string };

const absentString: string | undefined = undefined;
const absentBindings: readonly unknown[] | undefined = undefined;

function recordApiCall(apiCalls: ApiCall[], method: keyof CloudflareApi): void {
	apiCalls.push({ method });
}

function baseApi(apiCalls: ApiCall[]): CloudflareApi {
	return {
		listAccounts: () => {
			recordApiCall(apiCalls, 'listAccounts');
			return Promise.resolve([]);
		},
		r2BucketExists: () => {
			recordApiCall(apiCalls, 'r2BucketExists');
			return Promise.resolve(false);
		},
		ensureR2Bucket: () => {
			recordApiCall(apiCalls, 'ensureR2Bucket');
			return Promise.resolve();
		},
		ensureStagingLifecycleRule: () => {
			recordApiCall(apiCalls, 'ensureStagingLifecycleRule');
			return Promise.resolve();
		},
		ensureD1Database: () => {
			recordApiCall(apiCalls, 'ensureD1Database');
			return Promise.resolve('database-id');
		},
		ensureKvNamespace: () => {
			recordApiCall(apiCalls, 'ensureKvNamespace');
			return Promise.resolve('namespace-id');
		},
		ensureQueue: () => {
			recordApiCall(apiCalls, 'ensureQueue');
			return Promise.resolve('queue-id');
		},
		d1Query: () => {
			recordApiCall(apiCalls, 'd1Query');
			return Promise.resolve();
		},
		d1QueryRows: () => {
			recordApiCall(apiCalls, 'd1QueryRows');
			return Promise.resolve([]);
		},
		getScriptMigrationTag: () => {
			recordApiCall(apiCalls, 'getScriptMigrationTag');
			return Promise.resolve(absentString);
		},
		getScriptBindings: () => {
			recordApiCall(apiCalls, 'getScriptBindings');
			return Promise.resolve(absentBindings);
		},
		uploadScript: () => {
			recordApiCall(apiCalls, 'uploadScript');
			return Promise.resolve();
		},
		ensureQueueConsumer: () => {
			recordApiCall(apiCalls, 'ensureQueueConsumer');
			return Promise.resolve();
		},
		ensureSchedules: () => {
			recordApiCall(apiCalls, 'ensureSchedules');
			return Promise.resolve();
		},
		putSecret: () => {
			recordApiCall(apiCalls, 'putSecret');
			return Promise.resolve();
		},
		listScriptSecrets: () => {
			recordApiCall(apiCalls, 'listScriptSecrets');
			return Promise.resolve([]);
		},
		findZoneId: () => {
			recordApiCall(apiCalls, 'findZoneId');
			return Promise.resolve(absentString);
		},
		findCustomDomain: () => {
			recordApiCall(apiCalls, 'findCustomDomain');
			return Promise.resolve(absentString);
		},
		ensureCustomDomain: () => {
			recordApiCall(apiCalls, 'ensureCustomDomain');
			return Promise.resolve();
		},
		listTokenPermissionGroups: () => {
			recordApiCall(apiCalls, 'listTokenPermissionGroups');
			return Promise.resolve([]);
		},
		findApiTokenId: () => {
			recordApiCall(apiCalls, 'findApiTokenId');
			return Promise.resolve(absentString);
		},
		createApiToken: () => {
			apiCalls.push({
				method: 'createApiToken',
				name: '',
				policy: { permissionGroupIds: [], resources: {} }
			});

			return Promise.resolve({ id: 'token-id', value: 'token-value' });
		},
		rollApiTokenSecret: () => {
			recordApiCall(apiCalls, 'rollApiTokenSecret');
			return Promise.resolve('token-value');
		},
		getWorkersDevSubdomain: () => {
			recordApiCall(apiCalls, 'getWorkersDevSubdomain');
			return Promise.resolve(absentString);
		},
		enableWorkersDevRoute: () => {
			recordApiCall(apiCalls, 'enableWorkersDevRoute');
			return Promise.resolve();
		},
		queryWorkerLogs: () => Promise.resolve([])
	};
}

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
	it('creates a token scoped to the bucket and derives the S3 pair', async () => {
		const apiCalls: ApiCall[] = [];

		const api: CloudflareApi = {
			...baseApi(apiCalls),
			findApiTokenId: (name) => {
				apiCalls.push({ method: 'findApiTokenId' });
				return findIn({})(name);
			},
			listTokenPermissionGroups: () => {
				apiCalls.push({ method: 'listTokenPermissionGroups' });
				return Promise.resolve([...groups]);
			},
			createApiToken: (name, policy) => {
				apiCalls.push({ method: 'createApiToken', name, policy });
				return Promise.resolve({ id: 'token-id', value: 'token-value' });
			}
		};

		const credentials = await createScopedR2Key(api, options);

		expect({ credentials, apiCalls }).toStrictEqual({
			credentials: {
				accessKeyId: 'token-id',
				secretAccessKey: sha256('token-value')
			},
			apiCalls: [
				{ method: 'findApiTokenId' },
				{ method: 'listTokenPermissionGroups' },
				{
					method: 'createApiToken',
					name: scopedR2TokenName('cupboard-blobs'),
					policy: {
						permissionGroupIds: ['pg-write'],
						resources: {
							'com.cloudflare.edge.r2.bucket.acc-1_default_cupboard-blobs': '*'
						}
					}
				}
			]
		});
	});

	it('rolls the existing token on a re-deploy instead of creating another', async () => {
		const apiCalls: ApiCall[] = [];

		const api: CloudflareApi = {
			...baseApi(apiCalls),
			findApiTokenId: (name) => {
				apiCalls.push({ method: 'findApiTokenId' });
				return findIn({
					[scopedR2TokenName('cupboard-blobs')]: 'existing-id'
				})(name);
			},
			rollApiTokenSecret: (tokenId) => {
				apiCalls.push({ method: 'rollApiTokenSecret', tokenId });
				return Promise.resolve('rolled-value');
			}
		};

		const credentials = await createScopedR2Key(api, options);

		expect({ credentials, apiCalls }).toStrictEqual({
			credentials: {
				accessKeyId: 'existing-id',
				secretAccessKey: sha256('rolled-value')
			},
			apiCalls: [
				{ method: 'findApiTokenId' },
				{ method: 'rollApiTokenSecret', tokenId: 'existing-id' }
			]
		});
	});

	it('fails with the missing permission groups named', async () => {
		const apiCalls: ApiCall[] = [];
		const api: CloudflareApi = {
			...baseApi(apiCalls),
			findApiTokenId: (name) => {
				apiCalls.push({ method: 'findApiTokenId' });
				return findIn({})(name);
			},
			listTokenPermissionGroups: () => {
				apiCalls.push({ method: 'listTokenPermissionGroups' });
				return Promise.resolve([
					{ id: 'pg-other', name: 'Workers Scripts Write' }
				]);
			}
		};

		const resolveOutcome = async (): Promise<
			| { credentials: unknown }
			| { error: { name: string; wanted: readonly string[] } }
		> => {
			try {
				const credentials = await createScopedR2Key(api, options);

				return { credentials };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(R2PermissionGroupsError);

				if (error_ instanceof R2PermissionGroupsError) {
					return {
						error: {
							name: error_.name,
							wanted: error_.wanted
						}
					};
				}

				throw error_;
			}
		};

		const outcome = await resolveOutcome();

		expect({ outcome, apiCalls }).toStrictEqual({
			outcome: {
				error: {
					name: R2PermissionGroupsError.name,
					wanted: ['Workers R2 Storage Bucket Item Write']
				}
			},
			apiCalls: [
				{ method: 'findApiTokenId' },
				{ method: 'listTokenPermissionGroups' }
			]
		});
	});

	it('rejects a token response without a value', async () => {
		const apiCalls: ApiCall[] = [];
		const api: CloudflareApi = {
			...baseApi(apiCalls),
			findApiTokenId: (name) => {
				apiCalls.push({ method: 'findApiTokenId' });
				return findIn({})(name);
			},
			listTokenPermissionGroups: () => {
				apiCalls.push({ method: 'listTokenPermissionGroups' });
				return Promise.resolve([...groups]);
			},
			createApiToken: (name, policy) => {
				apiCalls.push({ method: 'createApiToken', name, policy });
				return Promise.resolve({ id: 'token-id', value: '' });
			}
		};

		const resolveOutcome = async (): Promise<
			| { credentials: unknown }
			| { error: { name: string; hasId: boolean; hasValue: boolean } }
		> => {
			try {
				const credentials = await createScopedR2Key(api, options);

				return { credentials };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(ApiTokenResponseError);

				if (error_ instanceof ApiTokenResponseError) {
					return {
						error: {
							name: error_.name,
							hasId: error_.hasId,
							hasValue: error_.hasValue
						}
					};
				}

				throw error_;
			}
		};

		const outcome = await resolveOutcome();

		expect({ outcome, apiCalls }).toStrictEqual({
			outcome: {
				error: {
					name: 'ApiTokenResponseError',
					hasId: true,
					hasValue: false
				}
			},
			apiCalls: [
				{ method: 'findApiTokenId' },
				{ method: 'listTokenPermissionGroups' },
				{
					method: 'createApiToken',
					name: scopedR2TokenName('cupboard-blobs'),
					policy: {
						permissionGroupIds: ['pg-write'],
						resources: {
							'com.cloudflare.edge.r2.bucket.acc-1_default_cupboard-blobs': '*'
						}
					}
				}
			]
		});
	});
});
