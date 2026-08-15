import { isDeepStrictEqual } from 'node:util';

import Cloudflare from 'cloudflare';
import { NotFoundError } from 'cloudflare';
import type { LifecycleUpdateParams } from 'cloudflare/resources/r2/buckets/lifecycle';
import type { ScriptUpdateParams } from 'cloudflare/resources/workers/scripts/scripts';
import { z } from 'zod';

import type { WorkerBundle } from './bundle.ts';
import {
	type CloudflareAccountId,
	cloudflareAccountIdSchema,
	type DatabaseId,
	databaseIdSchema,
	type KvNamespaceId,
	kvNamespaceIdSchema,
	type QueueId,
	queueIdSchema,
	type ScriptName,
	type ZoneId,
	zoneIdSchema
} from './identifiers.ts';

export interface AccountSummary {
	readonly id: CloudflareAccountId;
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
	/**
	The token's secret value; only ever returned at creation or roll.
	*/
	readonly value: string;
}

/**
A full-text query over a Worker's recent log events.
*/
export interface WorkerLogQuery {
	/**
	The text to match across each event (e.g. a request's cf-ray).
	*/
	readonly needle: string;
	readonly fromMs: number;
	readonly toMs: number;
	readonly limit: number;
}

/**
One matched log event, reduced to the fields a deploy surfaces.
*/
export interface WorkerLogEvent {
	readonly message: string | undefined;
	readonly error: string | undefined;
	readonly source: string;
}

/**
 * The Cloudflare operations the deploy pipeline performs, as a narrow interface
 * over the official SDK so the orchestration is testable against a fake. Every
 * method is reconcile-friendly: resource creators return the live id and are
 * safe to call when the resource already exists.
 */
export interface CloudflareApi {
	listAccounts(): Promise<AccountSummary[]>;

	r2BucketExists(name: string): Promise<boolean>;
	ensureR2Bucket(name: string): Promise<void>;
	/**
	 * Asserts the lifecycle rule that reclaims a push's transient `staging/`
	 * objects, expiring them and aborting their incomplete multipart uploads
	 * after a day. The bucket must already exist.
	 */
	ensureStagingLifecycleRule(bucketName: string): Promise<void>;
	ensureD1Database(name: string): Promise<DatabaseId>;
	ensureKvNamespace(title: string): Promise<KvNamespaceId>;
	ensureQueue(name: string): Promise<QueueId>;

	d1Query(databaseId: DatabaseId, sql: string): Promise<void>;
	d1QueryRows(databaseId: DatabaseId, sql: string): Promise<string[]>;

	getScriptMigrationTag(scriptName: ScriptName): Promise<string | undefined>;
	/**
	The script's live bindings, or undefined when it is not deployed.
	*/
	getScriptBindings(
		scriptName: ScriptName
	): Promise<readonly unknown[] | undefined>;
	uploadScript(
		scriptName: ScriptName,
		metadata: ScriptUpdateParams.Metadata,
		bundle: WorkerBundle
	): Promise<void>;

	ensureQueueConsumer(
		queueId: QueueId,
		scriptName: ScriptName,
		settings: QueueConsumerSettings
	): Promise<void>;
	ensureSchedules(
		scriptName: ScriptName,
		crons: readonly string[]
	): Promise<void>;
	putSecret(scriptName: ScriptName, secret: WorkerSecret): Promise<void>;
	listScriptSecrets(scriptName: ScriptName): Promise<string[]>;

	findZoneId(name: string): Promise<ZoneId | undefined>;
	/**
	The custom domain currently routed to the script, when one is.
	*/
	findCustomDomain(scriptName: ScriptName): Promise<string | undefined>;
	ensureCustomDomain(
		scriptName: ScriptName,
		hostname: string,
		zoneId: ZoneId
	): Promise<void>;

	listTokenPermissionGroups(): Promise<TokenPermissionGroup[]>;
	findApiTokenId(name: string): Promise<string | undefined>;
	createApiToken(
		name: string,
		policy: TokenPolicyInput
	): Promise<CreatedApiToken>;
	/**
	Rolls the token's secret, returning the new value.
	*/
	rollApiTokenSecret(tokenId: string): Promise<string>;

	/**
	The account's workers.dev subdomain, or undefined when unregistered.
	*/
	getWorkersDevSubdomain(): Promise<string | undefined>;
	enableWorkersDevRoute(scriptName: ScriptName): Promise<void>;

	/**
	 * Recent Workers Observability log events matching a full-text needle in a
	 * time window. Empty when observability is off for the script or nothing
	 * matches yet, since ingestion lags the request by a few seconds.
	 */
	queryWorkerLogs(query: WorkerLogQuery): Promise<readonly WorkerLogEvent[]>;
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

const stagingPrefix = 'staging/';
const stagingReclaimRuleId = 'cupboard-staging-reclaim';
const oneDayInSeconds = 24 * 60 * 60;

/**
 * The lifecycle rule reclaiming a push's transient staging objects: it expires
 * anything under `staging/` a day after it is written, and aborts incomplete
 * multipart uploads there a day after they begin. An abandoned incomplete
 * multipart upload is not a listable object, so this rule is the only thing
 * that can recover its storage.
 */
function stagingReclaimRule(): LifecycleUpdateParams.Rule {
	return {
		id: stagingReclaimRuleId,
		enabled: true,
		conditions: { prefix: stagingPrefix },
		deleteObjectsTransition: {
			condition: { type: 'Age', maxAge: oneDayInSeconds }
		},
		abortMultipartUploadsTransition: {
			condition: { type: 'Age', maxAge: oneDayInSeconds }
		}
	};
}

// The subset of a lifecycle rule this deploy owns. Projecting both the stored
// and desired rule down to it makes the idempotency check ignore fields R2 adds
// on its own.
interface ManagedLifecycleFields {
	readonly id?: string;
	readonly enabled?: boolean;
	readonly conditions?: { readonly prefix?: string };
	readonly deleteObjectsTransition?: unknown;
	readonly abortMultipartUploadsTransition?: unknown;
}

function managedLifecycleFields(rule: ManagedLifecycleFields): {
	id: string | undefined;
	enabled: boolean | undefined;
	prefix: string | undefined;
	deleteObjectsTransition: unknown;
	abortMultipartUploadsTransition: unknown;
} {
	return {
		id: rule.id,
		enabled: rule.enabled,
		prefix: rule.conditions?.prefix,
		deleteObjectsTransition: rule.deleteObjectsTransition,
		abortMultipartUploadsTransition: rule.abortMultipartUploadsTransition
	};
}

/**
 * The real {@link CloudflareApi}, backed by the official SDK. Resource creators
 * look the resource up by name first and create it only when absent, so a
 * re-run converges; existing resources are updated in place.
 */
export function createCloudflareApi(
	client: Cloudflare,
	accountId: CloudflareAccountId
): CloudflareApi {
	const account = { account_id: accountId };

	const isBucketPresent = async (name: string): Promise<boolean> => {
		const list = await client.r2.buckets.list(account);

		return (list.buckets ?? []).some((bucket) => bucket.name === name);
	};

	return {
		async listAccounts() {
			const accounts: AccountSummary[] = [];

			for await (const item of client.accounts.list()) {
				accounts.push({
					id: cloudflareAccountIdSchema.parse(item.id),
					name: item.name
				});
			}

			return accounts;
		},

		r2BucketExists: isBucketPresent,

		async ensureR2Bucket(name) {
			if (await isBucketPresent(name)) {
				return;
			}

			await client.r2.buckets.create({ ...account, name });
		},

		async ensureStagingLifecycleRule(bucketName) {
			const desired = stagingReclaimRule();

			const current = await client.r2.buckets.lifecycle.get(
				bucketName,
				account
			);
			const rules = current.rules ?? [];

			const existing = rules.find((rule) => rule.id === desired.id);

			// Compare only the fields this rule manages, not the whole object: R2 may
			// echo back optional fields (such as storage-class transitions) the rule
			// never sets, and comparing those would re-PUT an already-correct rule on
			// every deploy.
			if (
				existing !== undefined &&
				isDeepStrictEqual(
					managedLifecycleFields(existing),
					managedLifecycleFields(desired)
				)
			) {
				return;
			}

			const others = rules.filter((rule) => rule.id !== desired.id);

			await client.r2.buckets.lifecycle.update(bucketName, {
				...account,
				rules: [...others, desired]
			});
		},

		async ensureD1Database(name) {
			const existing = await firstMatch(
				client.d1.database.list({ ...account, name }),
				(database) => database.name === name
			);

			if (existing?.uuid !== undefined) {
				return databaseIdSchema.parse(existing.uuid);
			}

			const created = await client.d1.database.create({ ...account, name });

			return databaseIdSchema.parse(created.uuid ?? '');
		},

		async ensureKvNamespace(title) {
			const existing = await firstMatch(
				client.kv.namespaces.list(account),
				(namespace) => namespace.title === title
			);

			if (existing?.id !== undefined) {
				return kvNamespaceIdSchema.parse(existing.id);
			}

			const created = await client.kv.namespaces.create({ ...account, title });

			return kvNamespaceIdSchema.parse(created.id);
		},

		async ensureQueue(name) {
			const existing = await firstMatch(
				client.queues.list(account),
				(queue) => queue.queue_name === name
			);

			if (existing?.queue_id !== undefined) {
				return queueIdSchema.parse(existing.queue_id);
			}

			const created = await client.queues.create({
				...account,
				queue_name: name
			});

			return queueIdSchema.parse(created.queue_id ?? '');
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
			const form = new FormData();
			form.append(
				'metadata',
				new File([JSON.stringify(metadata)], 'metadata', {
					type: 'application/json'
				})
			);
			form.append(
				bundle.mainModule,
				new File([bundle.code], bundle.mainModule, {
					type: 'application/javascript+module'
				})
			);

			// The generated update method models these as nested fields, but the
			// Worker upload API requires the metadata and module as named parts.
			await client.put(
				`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}`,
				{ body: form }
			);
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

			const consumers: unknown[] = await Array.fromAsync(
				client.queues.consumers.list(queueId, account)
			);

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
				// leaving it unchanged is the only thing this deploy can do.
				return;
			}

			await client.queues.consumers.update(existing.consumer_id, {
				...body,
				queue_id: queueId
			});
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

			return zone === undefined ? undefined : zoneIdSchema.parse(zone.id);
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
		},

		async queryWorkerLogs(query) {
			const response = await client.workers.observability.telemetry.query({
				...account,
				queryId: 'cupboard-claim-failure',
				view: 'events',
				limit: query.limit,
				timeframe: { from: query.fromMs, to: query.toMs },
				parameters: { needle: { value: query.needle, matchCase: false } }
			});

			return (response.events?.events ?? []).map((event) => ({
				message: event.$metadata.message,
				error: event.$metadata.error,
				source:
					typeof event.source === 'string'
						? event.source
						: JSON.stringify(event.source)
			}));
		}
	};
}
