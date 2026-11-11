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
	| 'listCustomDomains'
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
			...control.queueConsumers.flatMap(
				(consumer) => consumer.deadLetterQueue ?? []
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
The release defaults, with the resource names and cron triggers replaced by
the values from the account's control Worker: the bucket, the database and
the maintenance queue from its bindings, the dead-letter queue from its queue
consumer, and the cron triggers from its schedules. When the control Worker
does not report a resource, the result has the release's default name for
it. `undefined` when the control Worker has not been deployed.

An empty schedule list is replaced by the default cron triggers, because the
control Worker runs maintenance only when a cron trigger fires. A first
deploy that failed after uploading the Workers also leaves the list empty.
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
The configuration that a plan starts from on an account, and the custom
domains that are routed to the account's control Worker.
*/
export interface StartingPlan {
	readonly config: DeploymentConfig;
	readonly routedDomains: readonly string[];
	/**
	Whether the account has the deployment's control Worker.
	*/
	readonly isExisting: boolean;
}

/**
A plan's change to the custom domains of an existing deployment. The deploy
keeps only the plan's domain, `to`, and removes every other domain in
`from`. `kind` says what the change does to the addresses that tenants were
created at:

- `first-domain`: the deployment served only its workers.dev address, which
  stays, so every tenant keeps its address.
- `move`: the deploy removes every current custom domain, so tenants created
  at one of them lose that address. An undefined `to` leaves only the
  workers.dev address.
- `removal`: the deployment keeps the plan's domain, which it already
  serves, and the deploy removes its other custom domains.
*/
export type DomainChange =
	| {
			readonly kind: 'first-domain';
			readonly from: readonly [];
			readonly to: string;
	  }
	| {
			readonly kind: 'removal';
			readonly from: readonly string[];
			readonly to: string;
	  }
	| {
			readonly kind: 'move';
			readonly from: readonly string[];
			readonly to: string | undefined;
	  };

/**
The custom domains that the change removes from the deployment.
*/
export function removedDomains(change: DomainChange): readonly string[] {
	const kept = change.to?.toLowerCase();

	return change.from.filter((domain) => domain.toLowerCase() !== kept);
}

function domainChangeOf(
	from: readonly string[],
	to: string | undefined
): DomainChange {
	if (to === undefined) {
		return { kind: 'move', from, to };
	}

	if (from.length === 0) {
		return { kind: 'first-domain', from: [], to };
	}

	const kept = to.toLowerCase();

	return {
		kind: from.some((domain) => domain.toLowerCase() === kept)
			? 'removal'
			: 'move',
		from,
		to
	};
}

/**
What a plan does to the deployment on the account: whether it updates an
existing deployment, and how it changes that deployment's custom domain.
*/
export interface DeploymentTarget {
	readonly isExisting: boolean;
	readonly domainChange: DomainChange | undefined;
}

/**
Returns the target of a plan that serves `domain` and starts from
`starting`.
*/
export function deploymentTarget(
	starting: StartingPlan,
	domain: string | undefined
): DeploymentTarget {
	if (!starting.isExisting) {
		return { isExisting: false, domainChange: undefined };
	}

	const planned = domain?.toLowerCase();
	const routed = starting.routedDomains.map((routedDomain) =>
		routedDomain.toLowerCase()
	);
	const isKept =
		planned === undefined
			? routed.length === 0
			: routed.length === 1 && routed[0] === planned;

	if (isKept) {
		return { isExisting: true, domainChange: undefined };
	}

	return {
		isExisting: true,
		domainChange: domainChangeOf(starting.routedDomains, domain)
	};
}

/**
Returns a lookup for the plan that a deploy starts from on each account. The
configuration is the existing deployment's configuration, or `defaults` on
an account without a control Worker. The lookup reads each account's
existing deployment once and returns the same result on later calls, so the
decision about R2 credentials and the DNS note after the review use the same
reading of the existing deployment as the plan.
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
			const [config, routedDomains] = await Promise.all([
				readExistingConfig(api, defaults),
				api.listCustomDomains(defaults.control.name)
			]);

			return {
				config: config ?? defaults,
				routedDomains,
				isExisting: config !== undefined
			};
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
