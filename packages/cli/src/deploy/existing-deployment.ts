import { z } from 'zod';

import { CliError } from '../errors.ts';

import { type CloudflareApi, liveD1BindingSchema } from './cloudflare-api.ts';
import {
	type DeploymentConfig,
	type EditableResourceKind,
	editableResourceKinds,
	type WorkerConfig
} from './config.ts';
import type { CloudflareAccountId } from './identifiers.ts';
import { renameResources, withCrons } from './overrides.ts';

/**
The release configuration uses one default name for two resources of one kind.
`readExistingConfig` maps each default name to one live name, so two references
with the same default name would both get the same live name.
*/
export class DuplicateDefaultResourceNameError extends CliError {
	constructor(
		public readonly kind: EditableResourceKind,
		public readonly resourceName: string
	) {
		super(
			`The release configuration uses the ${kind} name ${resourceName} more than once, so the deploy cannot tell which existing ${kind} each reference should use. This is a fault in the release; please report it.`
		);
		this.name = 'DuplicateDefaultResourceNameError';
	}
}

/**
The plan built from the existing deployment would make a queue its own
dead-letter queue. This happens when the control Worker produces to a queue
whose live name is the default dead-letter queue name, and the consumer of that
queue reports no dead-letter queue. The plan renames the consumer's queue to
that live name and keeps the default dead-letter queue name, so both names are
the same.
*/
export class DeadLetterQueueLoopError extends CliError {
	constructor(public readonly queue: string) {
		super(
			`The plan built from the existing deployment would make queue ${queue} its own dead-letter queue. Set a dead-letter queue on the control Worker's consumer of ${queue} in Cloudflare, then deploy again.`
		);
		this.name = 'DeadLetterQueueLoopError';
	}
}

export type ExistingDeploymentApi = Pick<
	CloudflareApi,
	| 'getScriptConfiguration'
	| 'findD1DatabaseName'
	| 'findConsumerDeadLetterQueue'
	| 'listSchedules'
	| 'findCustomDomain'
>;

type Rename = readonly [defaultName: string, liveName: string];

const r2Binding = z.looseObject({
	type: z.literal('r2_bucket'),
	name: z.string(),
	bucket_name: z.string()
});
const queueBinding = z.looseObject({
	type: z.literal('queue'),
	name: z.string(),
	queue_name: z.string()
});

function throwIfDefaultNamesRepeat(control: WorkerConfig): void {
	const defaultNames: Record<EditableResourceKind, readonly string[]> = {
		bucket: control.r2Buckets.map((bucket) => bucket.bucketName),
		database: control.d1Databases.map((database) => database.databaseName),
		queue: [
			...control.queueProducers.map((producer) => producer.queue),
			...control.queueConsumers.flatMap((consumer) =>
				consumer.deadLetterQueue === undefined ? [] : [consumer.deadLetterQueue]
			)
		]
	};

	for (const kind of editableResourceKinds) {
		const names = defaultNames[kind];
		const repeated = names.find((name, index) => names.indexOf(name) !== index);

		if (repeated !== undefined) {
			throw new DuplicateDefaultResourceNameError(kind, repeated);
		}
	}
}

function bindingsOf<T>(
	schema: z.ZodType<T>,
	bindings: readonly unknown[]
): T[] {
	return bindings.flatMap((binding) => {
		const parsed = schema.safeParse(binding);

		return parsed.success ? [parsed.data] : [];
	});
}

function throwIfDeadLetterLoop(config: DeploymentConfig): void {
	for (const consumer of config.control.queueConsumers) {
		if (consumer.deadLetterQueue === consumer.queue) {
			throw new DeadLetterQueueLoopError(consumer.queue);
		}
	}
}

/**
 * The release defaults, with the resource names and cron triggers replaced by
 * the values from the account's control Worker: the bucket, the database and
 * the maintenance queue from its bindings, the dead-letter queue from its queue
 * consumer, and the cron triggers from its schedules. When the control Worker
 * does not report a resource, the result has the release's default name for
 * it. `undefined` when the control Worker has not been deployed.
 *
 * An empty schedule list is replaced by the default cron triggers, because the
 * control Worker runs maintenance only when a cron trigger fires. A first
 * deploy that failed after uploading the Workers also leaves the list empty.
 */
export async function readExistingConfig(
	api: ExistingDeploymentApi,
	defaults: DeploymentConfig
): Promise<DeploymentConfig | undefined> {
	const control = defaults.control;
	const live = await api.getScriptConfiguration(control.name);

	if (live === undefined) {
		return undefined;
	}

	throwIfDefaultNamesRepeat(control);

	// Each release resource is paired with the live binding that has the same
	// name. When a release renames a binding, the deploy finds no live binding
	// with the new name, and the plan uses the default resource name. Renaming
	// a binding therefore needs a migration step.
	const liveBuckets = bindingsOf(r2Binding, live.bindings);
	const bucketRenames = control.r2Buckets.flatMap((bucket): Rename[] => {
		const bound = liveBuckets.find((entry) => entry.name === bucket.binding);

		return bound === undefined ? [] : [[bucket.bucketName, bound.bucket_name]];
	});

	const liveQueues = bindingsOf(queueBinding, live.bindings);
	const producerRenames = control.queueProducers.flatMap(
		(producer): Rename[] => {
			const bound = liveQueues.find((entry) => entry.name === producer.binding);

			return bound === undefined ? [] : [[producer.queue, bound.queue_name]];
		}
	);
	const liveQueueOf = (queue: string): string =>
		producerRenames.find(([defaultName]) => defaultName === queue)?.[1] ??
		queue;

	const liveDatabases = bindingsOf(liveD1BindingSchema, live.bindings);
	const readDatabaseRenames = control.d1Databases.map(
		async (database): Promise<Rename[]> => {
			const bound = liveDatabases.find(
				(entry) => entry.name === database.binding
			);
			const boundName =
				bound === undefined
					? undefined
					: await api.findD1DatabaseName(bound.database_id);

			return boundName === undefined
				? []
				: [[database.databaseName, boundName]];
		}
	);

	const readDeadLetterRenames = control.queueConsumers.map(
		async (consumer): Promise<Rename[]> => {
			if (consumer.deadLetterQueue === undefined) {
				return [];
			}

			const liveDeadLetters = await api.findConsumerDeadLetterQueue(
				liveQueueOf(consumer.queue),
				control.name
			);

			return liveDeadLetters === undefined
				? []
				: [[consumer.deadLetterQueue, liveDeadLetters]];
		}
	);

	const [databaseRenames, deadLetterRenames, liveCrons] = await Promise.all([
		Promise.all(readDatabaseRenames),
		Promise.all(readDeadLetterRenames),
		api.listSchedules(control.name)
	]);

	const existing = renameResources(defaults, {
		bucket: new Map(bucketRenames),
		database: new Map(databaseRenames.flat()),
		queue: new Map([...producerRenames, ...deadLetterRenames.flat()])
	});

	throwIfDeadLetterLoop(existing);

	return liveCrons.length === 0 ? existing : withCrons(existing, liveCrons);
}

/**
 * The configuration that a plan starts from on an account, and the custom
 * domain that is routed to the account's control Worker.
 */
export interface StartingPlan {
	readonly config: DeploymentConfig;
	readonly routedDomain: string | undefined;
}

/**
 * Returns a lookup for the plan that a deploy starts from on each account. The
 * configuration is the existing deployment's configuration, or `defaults` on
 * an account without a control Worker. The lookup reads each account's
 * existing deployment once and returns the same result on later calls, so the
 * decision about R2 credentials and the DNS note after the review use the same
 * reading of the existing deployment as the plan.
 */
export function startingPlanLookup(options: {
	readonly apiFor: (account: CloudflareAccountId) => ExistingDeploymentApi;
	readonly defaults: DeploymentConfig;
	readonly phase: <T>(label: string, read: () => Promise<T>) => Promise<T>;
}): (account: CloudflareAccountId) => Promise<StartingPlan> {
	const { apiFor, defaults, phase } = options;
	const starting = new Map<CloudflareAccountId, Promise<StartingPlan>>();

	const read = (account: CloudflareAccountId): Promise<StartingPlan> =>
		phase('Reading the existing deployment', async () => {
			const api = apiFor(account);
			const [config, routedDomain] = await Promise.all([
				readExistingConfig(api, defaults),
				api.findCustomDomain(defaults.control.name)
			]);

			return { config: config ?? defaults, routedDomain };
		});

	return (account) => {
		const existing = starting.get(account);

		if (existing !== undefined) {
			return existing;
		}

		const plan = read(account);
		starting.set(account, plan);

		return plan;
	};
}
