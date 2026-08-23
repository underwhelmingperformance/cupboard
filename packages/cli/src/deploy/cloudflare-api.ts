import { isDeepStrictEqual } from 'node:util';

import {
	filterProgressively,
	findProgressively,
	type ProgressivePage
} from '@cupboard/shared/collections';
import Cloudflare from 'cloudflare';
import { NotFoundError } from 'cloudflare';
import type { LifecycleUpdateParams } from 'cloudflare/resources/r2/buckets/lifecycle';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { CliError } from '../errors.ts';

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
import type { ScriptMetadata } from './upload.ts';

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

/**
Cloudflare returned a queue consumer that Cupboard must update, but the response
had no consumer ID.
*/
export class QueueConsumerIdMissingError extends CliError {
	constructor(
		public readonly queueId: QueueId,
		public readonly scriptName: ScriptName
	) {
		super(
			`Cloudflare returned the consumer for Worker ${scriptName} on queue ${queueId} with settings Cupboard must update, but the response had no consumer ID.`
		);
		this.name = 'QueueConsumerIdMissingError';
	}
}

export interface WorkerSecret {
	readonly name: string;
	readonly text: string;
}

export interface ScriptConfiguration {
	readonly buildVersion?: string;
	readonly bindings: readonly unknown[];
	readonly cacheEnabled: boolean;
	readonly crossVersionCache: boolean;
}

export interface WorkersDevelopmentRoutes {
	readonly workersDev: boolean;
	readonly previewUrls: boolean;
}

export interface CustomDomain {
	readonly hostname: string;
	readonly zoneId: ZoneId;
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
	The secret value, which Cloudflare returns only on creation or rotation.
	*/
	readonly value: string;
}

export interface WorkerLogQuery {
	readonly needle: string;
	readonly fromMs: number;
	readonly toMs: number;
	readonly limit: number;
}

export interface WorkerLogEvent {
	readonly message: string | undefined;
	readonly error: string | undefined;
	readonly source: string;
}

/**
 * The Cloudflare operations the deploy pipeline performs, as a narrow interface
 * over the official SDK. Resource-creation methods return the live id and are
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

	d1QueryBatch(
		databaseId: DatabaseId,
		statements: readonly string[]
	): Promise<void>;
	d1QueryRows(databaseId: DatabaseId, sql: string): Promise<string[]>;

	/**
	 * The live bindings and cache settings needed for deployment convergence.
	 * Returns `undefined` when the script is not deployed.
	 */
	getScriptConfiguration(
		scriptName: ScriptName
	): Promise<ScriptConfiguration | undefined>;
	uploadScript(
		scriptName: ScriptName,
		metadata: ScriptMetadata,
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
	findCustomDomain(scriptName: ScriptName): Promise<string | undefined>;
	setCustomDomain(
		scriptName: ScriptName,
		domain: CustomDomain | undefined
	): Promise<void>;

	listTokenPermissionGroups(): Promise<TokenPermissionGroup[]>;
	findApiTokenId(name: string): Promise<string | undefined>;
	createApiToken(
		name: string,
		policy: TokenPolicyInput
	): Promise<CreatedApiToken>;
	rollApiTokenSecret(tokenId: string): Promise<string>;

	getWorkersDevSubdomain(): Promise<string | undefined>;
	setWorkersDevRoutes(
		scriptName: ScriptName,
		routes: WorkersDevelopmentRoutes
	): Promise<void>;

	/**
	 * Recent Workers Observability log events matching a full-text needle in a
	 * time window. Returns an empty array when observability is off or no event
	 * matches yet, since ingestion lags the request by a few seconds.
	 */
	queryWorkerLogs(query: WorkerLogQuery): Promise<readonly WorkerLogEvent[]>;
}

interface CloudflarePage<T> {
	getPaginatedItems(): T[];
	hasNextPage(): boolean;
	getNextPage(): Promise<CloudflarePage<T>>;
}

export const maximumCloudflareCollectionItems = 10_000;
export const maximumCloudflareCollectionPages = 100;

function progressiveCloudflarePage<T>(
	page: CloudflarePage<T>
): ProgressivePage<T> {
	return {
		items: page.getPaginatedItems(),
		...(page.hasNextPage() && {
			next: async () => progressiveCloudflarePage(await page.getNextPage())
		})
	};
}

function cloudflareCollectionLimits(description: string) {
	return {
		description,
		maximumItems: maximumCloudflareCollectionItems,
		maximumPages: maximumCloudflareCollectionPages
	};
}

async function findCloudflareItem<T>(
	firstPage: PromiseLike<CloudflarePage<T>>,
	isMatch: (item: T) => boolean,
	description: string
): Promise<T | undefined> {
	return findProgressively(
		progressiveCloudflarePage(await firstPage),
		isMatch,
		cloudflareCollectionLimits(description)
	);
}

async function filterCloudflareItems<T>(
	firstPage: PromiseLike<CloudflarePage<T>>,
	isMatch: (item: T) => boolean,
	description: string
): Promise<T[]> {
	return filterProgressively(
		progressiveCloudflarePage(await firstPage),
		isMatch,
		cloudflareCollectionLimits(description)
	);
}

/**
 * A queue consumer as the live API returns it. The published schema (and the
 * SDK's types) say the Worker is named by `script_name`, but the live
 * endpoint returns `script` (and `service` for service bindings), which is
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
			max_concurrency: z.number().nullable().optional()
		})
		.optional()
});
const defaultQueueBatchSize = 10;
const defaultQueueBatchWaitMilliseconds = 5000;
const defaultQueueRetries = 3;

/**
 * Whether a live queue consumer uses the configured values, or Cloudflare's
 * documented defaults for settings the deployment omits.
 */
function isConsumerSettled(
	existing: {
		readonly settings?: {
			readonly batch_size?: number;
			readonly max_wait_time_ms?: number;
			readonly max_retries?: number;
			readonly max_concurrency?: number | null;
		};
		readonly dead_letter_queue?: string;
	},
	desired: QueueConsumerSettings
): boolean {
	const liveMaxConcurrency = existing.settings?.max_concurrency;
	const effectiveMaxConcurrency =
		typeof liveMaxConcurrency === 'number' ? liveMaxConcurrency : undefined;

	return (
		(existing.settings?.batch_size ?? defaultQueueBatchSize) ===
			(desired.maxBatchSize ?? defaultQueueBatchSize) &&
		(existing.settings?.max_wait_time_ms ??
			defaultQueueBatchWaitMilliseconds) ===
			(desired.maxBatchTimeout === undefined
				? defaultQueueBatchWaitMilliseconds
				: desired.maxBatchTimeout * 1000) &&
		(existing.settings?.max_retries ?? defaultQueueRetries) ===
			(desired.maxRetries ?? defaultQueueRetries) &&
		effectiveMaxConcurrency === desired.maxConcurrency &&
		(existing.dead_letter_queue ?? '') === (desired.deadLetterQueue ?? '')
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
		try {
			await client.r2.buckets.get(name, account);

			return true;
		} catch (error) {
			if (error instanceof NotFoundError) {
				return false;
			}

			throw error;
		}
	};

	return {
		async listAccounts() {
			const accounts = await filterCloudflareItems(
				client.accounts.list(),
				() => true,
				'Cloudflare account list'
			);

			return accounts.map((item) => ({
				id: cloudflareAccountIdSchema.parse(item.id),
				name: item.name
			}));
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
			const existing = await findCloudflareItem(
				client.d1.database.list({ ...account, name }),
				(database) => database.name === name,
				'Cloudflare D1 database list'
			);

			if (existing?.uuid !== undefined) {
				return databaseIdSchema.parse(existing.uuid);
			}

			const created = await client.d1.database.create({ ...account, name });

			return databaseIdSchema.parse(created.uuid ?? '');
		},

		async ensureKvNamespace(title) {
			const existing = await findCloudflareItem(
				client.kv.namespaces.list(account),
				(namespace) => namespace.title === title,
				'Cloudflare KV namespace list'
			);

			if (existing?.id !== undefined) {
				return kvNamespaceIdSchema.parse(existing.id);
			}

			const created = await client.kv.namespaces.create({ ...account, title });

			return kvNamespaceIdSchema.parse(created.id);
		},

		async ensureQueue(name) {
			const existing = await findCloudflareItem(
				client.queues.list(account),
				(queue) => queue.queue_name === name,
				'Cloudflare queue list'
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

		async d1QueryBatch(databaseId, statements) {
			await client.d1.database.query(databaseId, {
				...account,
				batch: statements.map((sql) => ({ sql }))
			});
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

		async getScriptConfiguration(scriptName) {
			try {
				const settings =
					await client.workers.scripts.scriptAndVersionSettings.get(
						scriptName,
						account
					);
				// Cloudflare returns cache_options here, but the pinned SDK's
				// response type omits it.
				const parsed = z
					.object({
						annotations: z
							.object({ 'workers/tag': z.string().optional() })
							.optional(),
						bindings: z.array(z.unknown()).default([]),
						cache_options: z
							.object({
								enabled: z.boolean(),
								cross_version_cache: z.boolean().optional()
							})
							.optional()
					})
					.parse(settings);

				return {
					...(parsed.annotations?.['workers/tag'] !== undefined && {
						buildVersion: parsed.annotations['workers/tag']
					}),
					bindings: parsed.bindings,
					cacheEnabled: parsed.cache_options?.enabled ?? false,
					crossVersionCache: parsed.cache_options?.cross_version_cache ?? false
				};
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

			const existing = await findCloudflareItem(
				client.queues.consumers.list(queueId, account),
				(consumer) => {
					const parsed = liveConsumerSchema.safeParse(consumer);

					return (
						parsed.success &&
						(parsed.data.type === undefined || parsed.data.type === 'worker') &&
						[
							parsed.data.script_name,
							parsed.data.script,
							parsed.data.service
						].includes(scriptName)
					);
				},
				'Cloudflare queue consumer list'
			);

			if (existing === undefined) {
				await client.queues.consumers.create(queueId, body);
				return;
			}

			const parsedExisting = liveConsumerSchema.parse(existing);

			if (isConsumerSettled(parsedExisting, settings)) {
				return;
			}

			if (
				parsedExisting.consumer_id === undefined ||
				parsedExisting.consumer_id === ''
			) {
				throw new QueueConsumerIdMissingError(queueId, scriptName);
			}

			// This endpoint is PUT, so omitted settings return to their platform
			// defaults when a deployment removes them.
			await client.queues.consumers.update(parsedExisting.consumer_id, {
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
			try {
				const secrets = await filterCloudflareItems(
					client.workers.scripts.secrets.list(scriptName, account),
					() => true,
					'Cloudflare Worker secret list'
				);

				return secrets.map((secret) => secret.name);
			} catch (error) {
				// A script that has not been deployed yet has no secrets to list.
				if (
					error instanceof Error &&
					'status' in error &&
					error.status === StatusCodes.NOT_FOUND
				) {
					return [];
				}

				throw error;
			}
		},

		async findZoneId(name) {
			const zone = await findCloudflareItem(
				client.zones.list({ name }),
				(item) => item.name === name,
				'Cloudflare zone list'
			);

			return zone === undefined ? undefined : zoneIdSchema.parse(zone.id);
		},

		async findCustomDomain(scriptName) {
			const existing = await findCloudflareItem(
				client.workers.domains.list(account),
				(domain) => domain.service === scriptName,
				'Cloudflare Worker domain list'
			);

			return existing?.hostname;
		},

		async setCustomDomain(scriptName, desired) {
			const current = await filterCloudflareItems(
				client.workers.domains.list(account),
				(domain) => domain.service === scriptName,
				'Cloudflare Worker domain list'
			);

			if (
				desired !== undefined &&
				current.every((domain) => domain.hostname !== desired.hostname)
			) {
				await client.workers.domains.update({
					...account,
					hostname: desired.hostname,
					zone_id: desired.zoneId,
					service: scriptName,
					environment: 'production'
				});
			}

			for (const domain of current) {
				if (domain.hostname === desired?.hostname) {
					continue;
				}

				await client.workers.domains.delete(domain.id, account);
			}
		},

		async listTokenPermissionGroups() {
			const groups = await filterCloudflareItems(
				client.accounts.tokens.permissionGroups.list(account),
				(group) => group.id !== undefined && group.name !== undefined,
				'Cloudflare token permission group list'
			);

			return groups.map((group) => ({
				id: group.id ?? '',
				name: group.name ?? ''
			}));
		},

		async findApiTokenId(name) {
			const existing = await findCloudflareItem(
				client.accounts.tokens.list(account),
				(token) => token.name === name,
				'Cloudflare API token list'
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

		async setWorkersDevRoutes(scriptName, routes) {
			await client.workers.scripts.subdomain.create(scriptName, {
				...account,
				enabled: routes.workersDev,
				previews_enabled: routes.previewUrls
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
