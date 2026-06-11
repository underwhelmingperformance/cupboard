import Cloudflare from 'cloudflare';
import { toFile } from 'cloudflare';
import type { ScriptUpdateParams } from 'cloudflare/resources/workers/scripts/scripts';

import type { WorkerBundle } from './bundle.ts';

export interface AccountSummary {
	readonly id: string;
	readonly name: string;
}

export interface QueueConsumerSettings {
	readonly maxBatchSize: number | undefined;
	readonly maxBatchTimeout: number | undefined;
	readonly maxRetries: number | undefined;
	readonly maxConcurrency: number | undefined;
	readonly deadLetterQueue: string | undefined;
}

export interface WorkerSecret {
	readonly name: string;
	readonly text: string;
}

export interface TokenPermissionGroup {
	readonly id: string;
	readonly name: string;
}

export interface TokenPolicyInput {
	readonly permissionGroupIds: readonly string[];
	readonly resources: Readonly<Record<string, string>>;
}

export interface CreatedApiToken {
	readonly id: string;
	/** The token's secret value; only ever returned at creation or roll. */
	readonly value: string;
}

/**
 * The Cloudflare operations the deploy pipeline performs, as a narrow seam over
 * the official SDK so the orchestration is testable against a fake. Every method
 * is reconcile-friendly: resource creators return the live id and are safe to
 * call when the resource already exists.
 */
export interface CloudflareApi {
	listAccounts(): Promise<AccountSummary[]>;

	r2BucketExists(name: string): Promise<boolean>;
	ensureR2Bucket(name: string): Promise<void>;
	ensureD1Database(name: string): Promise<string>;
	ensureKvNamespace(title: string): Promise<string>;
	ensureQueue(name: string): Promise<string>;

	d1Query(databaseId: string, sql: string): Promise<void>;
	d1QueryRows(databaseId: string, sql: string): Promise<string[]>;

	getScriptMigrationTag(scriptName: string): Promise<string | undefined>;
	uploadScript(
		scriptName: string,
		metadata: ScriptUpdateParams.Metadata,
		bundle: WorkerBundle
	): Promise<void>;

	putQueueConsumer(
		queueId: string,
		scriptName: string,
		settings: QueueConsumerSettings
	): Promise<void>;
	putSchedules(scriptName: string, crons: readonly string[]): Promise<void>;
	putSecret(scriptName: string, secret: WorkerSecret): Promise<void>;
	listScriptSecrets(scriptName: string): Promise<string[]>;

	findZoneId(name: string): Promise<string | undefined>;
	attachCustomDomain(
		scriptName: string,
		hostname: string,
		zoneId: string
	): Promise<void>;

	listTokenPermissionGroups(): Promise<TokenPermissionGroup[]>;
	findApiTokenId(name: string): Promise<string | undefined>;
	createApiToken(
		name: string,
		policy: TokenPolicyInput
	): Promise<CreatedApiToken>;
	/** Rolls the token's secret, returning the new value. */
	rollApiTokenSecret(tokenId: string): Promise<string>;
}

async function firstMatch<T>(
	page: AsyncIterable<T>,
	matches: (item: T) => boolean
): Promise<T | undefined> {
	for await (const item of page) {
		if (matches(item)) {
			return item;
		}
	}

	return undefined;
}

/**
 * The real {@link CloudflareApi}, backed by the official SDK. Resource creators
 * look the resource up by name first and create it only when absent, so a
 * re-run converges rather than failing on conflicts.
 */
export function createCloudflareApi(
	client: Cloudflare,
	accountId: string
): CloudflareApi {
	const account = { account_id: accountId };

	const bucketExists = async (name: string): Promise<boolean> => {
		const list = await client.r2.buckets.list(account);

		return (list.buckets ?? []).some((bucket) => bucket.name === name);
	};

	return {
		async listAccounts() {
			const accounts: AccountSummary[] = [];

			for await (const item of client.accounts.list()) {
				accounts.push({ id: item.id, name: item.name });
			}

			return accounts;
		},

		r2BucketExists: bucketExists,

		async ensureR2Bucket(name) {
			if (await bucketExists(name)) {
				return;
			}

			await client.r2.buckets.create({ ...account, name });
		},

		async ensureD1Database(name) {
			const existing = await firstMatch(
				client.d1.database.list({ ...account, name }),
				(database) => database.name === name
			);

			if (existing?.uuid !== undefined) {
				return existing.uuid;
			}

			const created = await client.d1.database.create({ ...account, name });

			return created.uuid ?? '';
		},

		async ensureKvNamespace(title) {
			const existing = await firstMatch(
				client.kv.namespaces.list(account),
				(namespace) => namespace.title === title
			);

			if (existing?.id !== undefined) {
				return existing.id;
			}

			const created = await client.kv.namespaces.create({ ...account, title });

			return created.id;
		},

		async ensureQueue(name) {
			const existing = await firstMatch(
				client.queues.list(account),
				(queue) => queue.queue_name === name
			);

			if (existing?.queue_id !== undefined) {
				return existing.queue_id;
			}

			const created = await client.queues.create({
				...account,
				queue_name: name
			});

			return created.queue_id ?? '';
		},

		async d1Query(databaseId, sql) {
			await client.d1.database.query(databaseId, { ...account, sql });
		},

		async d1QueryRows(databaseId, sql) {
			const response = await client.d1.database.query(databaseId, {
				...account,
				sql
			});

			const rows: string[] = [];

			for (const result of response.result) {
				for (const record of result.results ?? []) {
					const value = (record as Record<string, unknown>).name;

					if (typeof value === 'string') {
						rows.push(value);
					}
				}
			}

			return rows;
		},

		async getScriptMigrationTag(scriptName) {
			const script = await firstMatch(
				client.workers.scripts.list(account),
				(item) => item.id === scriptName
			);

			return script?.migration_tag ?? undefined;
		},

		async uploadScript(scriptName, metadata, bundle) {
			const file = await toFile(
				Buffer.from(bundle.code, 'utf8'),
				bundle.mainModule,
				{ type: 'application/javascript+module' }
			);

			await client.workers.scripts.update(scriptName, {
				...account,
				metadata,
				files: [file]
			});
		},

		async putQueueConsumer(queueId, scriptName, settings) {
			await client.queues.consumers.create(queueId, {
				...account,
				type: 'worker',
				script_name: scriptName,
				settings: {
					...(settings.maxBatchSize === undefined
						? {}
						: { batch_size: settings.maxBatchSize }),
					...(settings.maxBatchTimeout === undefined
						? {}
						: { max_wait_time_ms: settings.maxBatchTimeout * 1000 }),
					...(settings.maxRetries === undefined
						? {}
						: { max_retries: settings.maxRetries }),
					...(settings.maxConcurrency === undefined
						? {}
						: { max_concurrency: settings.maxConcurrency })
				},
				...(settings.deadLetterQueue === undefined
					? {}
					: { dead_letter_queue: settings.deadLetterQueue })
			});
		},

		async putSchedules(scriptName, crons) {
			await client.workers.scripts.schedules.update(scriptName, {
				...account,
				body: crons.map((cron) => ({ cron }))
			});
		},

		async putSecret(scriptName, secret) {
			await client.workers.scripts.secrets.update(scriptName, {
				...account,
				name: secret.name,
				text: secret.text,
				type: 'secret_text'
			});
		},

		async listScriptSecrets(scriptName) {
			const names: string[] = [];

			try {
				for await (const secret of client.workers.scripts.secrets.list(
					scriptName,
					account
				)) {
					names.push(secret.name);
				}
			} catch (error) {
				// A script that has not been deployed yet has no secrets to list.
				if (
					error instanceof Error &&
					'status' in error &&
					error.status === 404
				) {
					return [];
				}

				throw error;
			}

			return names;
		},

		async findZoneId(name) {
			const zone = await firstMatch(
				client.zones.list({ name }),
				(item) => item.name === name
			);

			return zone?.id;
		},

		async attachCustomDomain(scriptName, hostname, zoneId) {
			await client.workers.domains.update({
				...account,
				hostname,
				zone_id: zoneId,
				service: scriptName,
				environment: 'production'
			});
		},

		async listTokenPermissionGroups() {
			const groups: TokenPermissionGroup[] = [];

			for await (const group of client.accounts.tokens.permissionGroups.list(
				account
			)) {
				if (group.id !== undefined && group.name !== undefined) {
					groups.push({ id: group.id, name: group.name });
				}
			}

			return groups;
		},

		async findApiTokenId(name) {
			const existing = await firstMatch(
				client.accounts.tokens.list(account),
				(token) => token.name === name
			);

			return existing?.id;
		},

		async createApiToken(name, policy) {
			const created = await client.accounts.tokens.create({
				...account,
				name,
				policies: [
					{
						effect: 'allow',
						permission_groups: policy.permissionGroupIds.map((id) => ({
							id
						})),
						resources: { ...policy.resources }
					}
				]
			});

			return { id: created.id ?? '', value: created.value ?? '' };
		},

		async rollApiTokenSecret(tokenId) {
			return client.accounts.tokens.value.update(tokenId, {
				...account,
				body: {}
			});
		}
	};
}
