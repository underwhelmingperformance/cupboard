import Cloudflare from 'cloudflare';
import { NotFoundError, toFile } from 'cloudflare';
import type { ScriptUpdateParams } from 'cloudflare/resources/workers/scripts/scripts';
import { z } from 'zod';

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
	/** The script's live bindings, or undefined when it is not deployed. */
	getScriptBindings(
		scriptName: string
	): Promise<readonly unknown[] | undefined>;
	uploadScript(
		scriptName: string,
		metadata: ScriptUpdateParams.Metadata,
		bundle: WorkerBundle
	): Promise<void>;

	ensureQueueConsumer(
		queueId: string,
		scriptName: string,
		settings: QueueConsumerSettings
	): Promise<void>;
	ensureSchedules(scriptName: string, crons: readonly string[]): Promise<void>;
	putSecret(scriptName: string, secret: WorkerSecret): Promise<void>;
	listScriptSecrets(scriptName: string): Promise<string[]>;

	findZoneId(name: string): Promise<string | undefined>;
	/** The custom domain currently routed to the script, when one is. */
	findCustomDomain(scriptName: string): Promise<string | undefined>;
	ensureCustomDomain(
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

	/** The account's workers.dev subdomain, or undefined when unregistered. */
	getWorkersDevSubdomain(): Promise<string | undefined>;
	enableWorkersDevRoute(scriptName: string): Promise<void>;
}

async function firstMatch<T>(
	page: AsyncIterable<T>,
	isMatch: (item: T) => boolean
): Promise<T | undefined> {
	for await (const item of page) {
		if (isMatch(item)) {
			return item;
		}
	}

	return undefined;
}

/**
 * A queue consumer as the live API answers it. The published schema (and the
 * SDK's types) say the Worker is named by `script_name`, but the live
 * endpoint answers `script` (and `service` for service bindings), which is
 * also what wrangler matches on. All spellings are read, and the parse is
 * deliberately independent of the SDK's view of the wire.
 */
const liveConsumerSchema = z.object({
	type: z.string().optional(),
	consumer_id: z.string().optional(),
	script_name: z.string().optional(),
	script: z.string().optional(),
	service: z.string().optional(),
	dead_letter_queue: z.string().optional(),
	settings: z
		.object({
			batch_size: z.number().optional(),
			max_wait_time_ms: z.number().optional(),
			max_retries: z.number().optional(),
			max_concurrency: z.number().optional()
		})
		.optional()
});

/**
 * Whether a live queue consumer already carries every setting the deploy
 * would write. Settings the config leaves undefined are the platform's to
 * default, so they do not count against a match.
 */
function isConsumerSettled(
	existing: {
		readonly settings?: {
			readonly batch_size?: number;
			readonly max_wait_time_ms?: number;
			readonly max_retries?: number;
			readonly max_concurrency?: number;
		};
		readonly dead_letter_queue?: string;
	},
	desired: QueueConsumerSettings
): boolean {
	const isSettled = (
		want: number | undefined,
		live: number | undefined
	): boolean => want === undefined || want === live;

	return (
		isSettled(desired.maxBatchSize, existing.settings?.batch_size) &&
		isSettled(
			desired.maxBatchTimeout === undefined
				? undefined
				: desired.maxBatchTimeout * 1000,
			existing.settings?.max_wait_time_ms
		) &&
		isSettled(desired.maxRetries, existing.settings?.max_retries) &&
		isSettled(desired.maxConcurrency, existing.settings?.max_concurrency) &&
		(desired.deadLetterQueue === undefined ||
			desired.deadLetterQueue === existing.dead_letter_queue)
	);
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

	const hasBucket = async (name: string): Promise<boolean> => {
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

		r2BucketExists: hasBucket,

		async ensureR2Bucket(name) {
			if (await hasBucket(name)) {
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
				const records = result.results ?? [];
				for (const record of records) {
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

		async getScriptBindings(scriptName) {
			try {
				const settings =
					await client.workers.scripts.scriptAndVersionSettings.get(
						scriptName,
						account
					);

				return settings.bindings ?? [];
			} catch (error) {
				if (error instanceof NotFoundError) {
					return;
				}

				throw error;
			}
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

		async ensureQueueConsumer(queueId, scriptName, settings) {
			const body = {
				...account,
				type: 'worker' as const,
				script_name: scriptName,
				settings: {
					...(settings.maxBatchSize !== undefined && {
						batch_size: settings.maxBatchSize
					}),
					...(settings.maxBatchTimeout !== undefined && {
						max_wait_time_ms: settings.maxBatchTimeout * 1000
					}),
					...(settings.maxRetries !== undefined && {
						max_retries: settings.maxRetries
					}),
					...(settings.maxConcurrency !== undefined && {
						max_concurrency: settings.maxConcurrency
					})
				},
				...(settings.deadLetterQueue !== undefined && {
					dead_letter_queue: settings.deadLetterQueue
				})
			};

			const consumers: unknown[] = [];

			for await (const consumer of client.queues.consumers.list(
				queueId,
				account
			)) {
				consumers.push(consumer);
			}

			const existing = consumers
				.map((consumer) => liveConsumerSchema.safeParse(consumer))
				.filter((parsed) => parsed.success)
				.map((parsed) => parsed.data)
				.find(
					(consumer) =>
						(consumer.type === undefined || consumer.type === 'worker') &&
						[consumer.script_name, consumer.script, consumer.service].includes(
							scriptName
						)
				);

			if (existing === undefined) {
				await client.queues.consumers.create(queueId, body);
				return;
			}

			if (isConsumerSettled(existing, settings)) {
				return;
			}

			if (existing.consumer_id === undefined) {
				// A matched consumer that cannot be addressed cannot be updated;
				// leaving it is the only convergent move.
				return;
			}

			await client.queues.consumers.update(queueId, existing.consumer_id, body);
		},

		async ensureSchedules(scriptName, crons) {
			const current = await client.workers.scripts.schedules.get(
				scriptName,
				account
			);
			const live = current.schedules.map((schedule) => schedule.cron);

			if (
				live.length === crons.length &&
				live.every((cron, index) => cron === crons[index])
			) {
				return;
			}

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

		async findCustomDomain(scriptName) {
			const existing = await firstMatch(
				client.workers.domains.list(account),
				(domain) => domain.service === scriptName
			);

			return existing?.hostname;
		},

		async ensureCustomDomain(scriptName, hostname, zoneId) {
			const existing = await firstMatch(
				client.workers.domains.list(account),
				(domain) => domain.hostname === hostname
			);

			if (existing?.service === scriptName) {
				return;
			}

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

		rollApiTokenSecret: async (tokenId) =>
			client.accounts.tokens.value.update(tokenId, {
				...account,
				body: {}
			}),

		async getWorkersDevSubdomain() {
			try {
				const response = await client.workers.subdomains.get(account);

				return response.subdomain === '' ? undefined : response.subdomain;
			} catch (error) {
				if (error instanceof NotFoundError) {
					return;
				}

				throw error;
			}
		},

		async enableWorkersDevRoute(scriptName) {
			await client.workers.scripts.subdomain.create(scriptName, {
				...account,
				enabled: true
			});
		}
	};
}
