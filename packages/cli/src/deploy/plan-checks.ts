import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { z } from 'zod';

import { CliUsageError } from '../errors.ts';

import type { DeploymentArtifact } from './artifact.ts';
import {
	areRoutesListed,
	type CloudflareApi,
	liveD1BindingSchema,
	type UncheckedRoutes
} from './cloudflare-api.ts';
import { type DeploymentConfig, deploymentD1Bindings } from './config.ts';
import { findHostnameZoneId } from './deploy-run.ts';
import {
	ensurePhaseTableStatement,
	ensureTransitionTableStatement
} from './deployment-state.ts';
import { type DomainChange, removedDomains } from './existing-deployment.ts';
import type { ScriptName } from './identifiers.ts';
import { ensureTrackingTableStatement } from './migrations.ts';

/**
A Worker with the name of one of the plan's Workers exists, but it has no
Durable Object binding to the `CupboardServer` class. Every cupboard control
Worker binds the class, and every tenant Worker defines it. Deploying would
replace an unrelated Worker.
*/
export class UnrecognisedWorkerError extends CliUsageError {
	constructor(public readonly worker: ScriptName) {
		super(
			`The account has a Worker called ${worker}, but it is not one of a cupboard deployment's Workers: it has no Durable Object binding to the CupboardServer class. ` +
				'Choose another --deployment-name. Nothing was changed.'
		);
		this.name = 'UnrecognisedWorkerError';
	}
}

/**
A D1 database with a name from the plan exists and has tables, but its
`d1_migrations` table does not record the first migration of the release's
migrations for that database, so cupboard did not create it. Wrangler
creates the same table, so the table alone does not identify cupboard's
databases. Deploying would apply cupboard's migrations to an unrelated
database.
*/
export class UnrecognisedDatabaseError extends CliUsageError {
	constructor(
		public readonly database: string,
		public readonly firstMigration: string
	) {
		super(
			`The account has a D1 database called ${database}, but cupboard did not create it: it has tables, and it has not recorded cupboard's first migration, ${firstMigration}. ` +
				'Choose another --deployment-name, or another database name in the plan. Nothing was changed.'
		);
		this.name = 'UnrecognisedDatabaseError';
	}
}

/**
The kinds of resource that a Worker outside the deployment can use.
*/
export type SharedResourceKind = 'database' | 'bucket' | 'queue';

const sharedResourceDescriptions: Record<SharedResourceKind, string> = {
	database: 'D1 database',
	bucket: 'R2 bucket',
	queue: 'queue'
};

/**
A database, bucket or queue with a name from the plan is used by a Worker
outside this deployment, so it belongs to another deployment. This happens
when the plan menu renames a resource to another deployment's. Deploying
would let two deployments share it.
*/
export class ResourceOfOtherWorkerError extends CliUsageError {
	constructor(
		public readonly kind: SharedResourceKind,
		public readonly resource: string,
		public readonly worker: ScriptName
	) {
		super(
			`The ${sharedResourceDescriptions[kind]} ${resource} is used by the Worker ${worker}, which is not part of this deployment, so it belongs to another deployment. ` +
				'Choose another name in the plan, or another --deployment-name. Nothing was changed.'
		);
		this.name = 'ResourceOfOtherWorkerError';
	}
}

/**
The deploy could not read the bindings of a Worker on the account, so it
cannot tell whether that Worker uses one of the plan's resources.
*/
export class WorkerBindingsUnreadableError extends CliUsageError {
	constructor(
		public readonly worker: ScriptName,
		options: { readonly cause: unknown }
	) {
		super(
			`The deploy could not read the bindings of the Worker ${worker} (${causeText(options.cause)}), so it cannot check whether that Worker uses a resource of this plan. ` +
				"Deploy again once Cloudflare returns the Worker's settings. Nothing was changed.",
			options
		);
		this.name = 'WorkerBindingsUnreadableError';
	}
}

/**
The deploy could not list the Workers on the account, so it cannot tell
whether one of them uses a resource of the plan.
*/
export class AccountWorkersUnlistedError extends CliUsageError {
	constructor(options: { readonly cause: unknown }) {
		super(
			`The deploy could not list the Workers on the account (${causeText(options.cause)}), so it cannot check whether one of them uses a resource of this plan. ` +
				'Deploy again once Cloudflare lists them. Nothing was changed.',
			options
		);
		this.name = 'AccountWorkersUnlistedError';
	}
}

function causeText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
What the plan does to a custom domain: attaches it to the deployment, or
removes it.
*/
export type CustomDomainAction = 'attach' | 'remove';

const customDomainActionVerbs: Record<CustomDomainAction, string> = {
	attach: 'attaching',
	remove: 'removing'
};

const domainActionAlternative: Record<CustomDomainAction, string> = {
	attach: ', or deploy without a new custom domain',
	remove: ', or remove the custom domain in the Cloudflare dashboard first'
};

/**
The Cloudflare token may not list the Workers routes in the zone of a
custom domain that the plan attaches or removes. Changing a custom domain
needs the Workers Routes: Edit permission on its zone, so the deploy would
fail after it had uploaded the Workers.
*/
export class RoutesPermissionRequiredError extends CliUsageError {
	constructor(
		public readonly hostname: string,
		public readonly action: CustomDomainAction
	) {
		super(
			`The Cloudflare token may not list the Workers routes in the zone of ${hostname}, and ${customDomainActionVerbs[action]} the custom domain ${hostname} needs the Workers Routes: Edit permission on that zone. ` +
				`Give the token that permission${domainActionAlternative[action]}. Nothing was changed.`
		);
		this.name = 'RoutesPermissionRequiredError';
	}
}

/**
The token cannot see the zone of a custom domain that the plan attaches or
removes, so the deploy cannot change that domain.
*/
export class DomainZoneUnavailableError extends CliUsageError {
	constructor(
		public readonly hostname: string,
		public readonly action: CustomDomainAction
	) {
		super(
			`The Cloudflare token cannot see a zone for ${hostname}, so the deploy cannot ${action} the custom domain ${hostname}. ` +
				`The zone must be in this account, and the token needs Zone: Read and Workers Routes: Edit on it${domainActionAlternative[action]}. Nothing was changed.`
		);
		this.name = 'DomainZoneUnavailableError';
	}
}

/**
The result of reading the account's Workers other than the deployment's
own: their bindings by script name; a Worker whose bindings could not be
read, which stops the scan; or the failure to list the Workers.
*/
export type AccountWorkers =
	| {
			readonly kind: 'read';
			readonly bindings: ReadonlyMap<ScriptName, readonly unknown[]>;
	  }
	| {
			readonly kind: 'unreadable';
			readonly worker: ScriptName;
			readonly cause: unknown;
	  }
	| { readonly kind: 'unlisted'; readonly cause: unknown };

const scanConcurrency = 6;

/**
A Worker whose bindings the scan could not read. The scan throws it so that
no further reads start.
*/
class UnreadableWorker extends Error {
	constructor(
		readonly worker: ScriptName,
		options: { readonly cause: unknown }
	) {
		super(`Could not read the bindings of ${worker}`, options);
		this.name = 'UnreadableWorker';
	}
}

/**
Reads the bindings of every Worker on the account except those in
`excluded`, at most six at a time. The Cloudflare client retries transient
failures. The scan stops at the first Worker whose bindings still cannot be
read, and reports it instead of the bindings.
*/
export async function scanAccountWorkers(
	api: Pick<CloudflareApi, 'listScriptNames' | 'getScriptConfiguration'>,
	excluded: ReadonlySet<string>
): Promise<AccountWorkers> {
	let names: ScriptName[];

	try {
		names = await api.listScriptNames();
	} catch (error) {
		return { kind: 'unlisted', cause: error };
	}

	try {
		const bindings = await mapWithConcurrency(
			names.filter((name) => !excluded.has(name)),
			scanConcurrency,
			async (name) => {
				try {
					const live = await api.getScriptConfiguration(name);

					return [name, live?.bindings ?? []] as const;
				} catch (error) {
					throw new UnreadableWorker(name, { cause: error });
				}
			}
		);

		return { kind: 'read', bindings: new Map(bindings) };
	} catch (error) {
		if (error instanceof UnreadableWorker) {
			return { kind: 'unreadable', worker: error.worker, cause: error.cause };
		}

		throw error;
	}
}

/**
Returns `scan` with each account's result kept for the rest of the run. A
scan that could not list or read the account's Workers is not kept, so the
next check reads the account again.
*/
export function accountScanCache<Account>(
	scan: (account: Account) => Promise<AccountWorkers>
): (account: Account) => Promise<AccountWorkers> {
	const scans = new Map<Account, Promise<AccountWorkers>>();

	return (account) => {
		const existing = scans.get(account);

		if (existing !== undefined) {
			return existing;
		}

		const result = scan(account);
		scans.set(account, result);
		void result
			.then((workers) => {
				if (workers.kind !== 'read') {
					scans.delete(account);
				}
			})
			.catch(() => {
				scans.delete(account);
			});

		return result;
	};
}

/**
Returns the refusal for a resource that a Worker outside the deployment
uses, or `undefined` when none does.
*/
type OutsideUse = (
	kind: SharedResourceKind,
	resource: string,
	isUsedBy: (bindings: readonly unknown[]) => boolean
) => Promise<CliUsageError | undefined>;

function outsideUseLookup(
	api: PlanCheckApi,
	own: ReadonlySet<string>
): OutsideUse {
	return async (kind, resource, isUsedBy) => {
		const read = await api.accountWorkers();

		if (read.kind === 'unlisted') {
			return new AccountWorkersUnlistedError({ cause: read.cause });
		}

		if (read.kind === 'unreadable') {
			return new WorkerBindingsUnreadableError(read.worker, {
				cause: read.cause
			});
		}

		for (const [name, bindings] of read.bindings) {
			if (!own.has(name) && isUsedBy(bindings)) {
				return new ResourceOfOtherWorkerError(kind, resource, name);
			}
		}

		return;
	};
}

/**
The kinds of account resource, other than Workers and databases, that a
deployment has names for.
*/
export type CheckedResourceKind = 'bucket' | 'queue' | 'kv-namespace';

const resourceDescriptions: Record<CheckedResourceKind, string> = {
	bucket: 'an R2 bucket',
	queue: 'a queue',
	'kv-namespace': 'a KV namespace'
};

const resourceUses: Record<CheckedResourceKind, string> = {
	bucket: 'it contains objects',
	queue: 'another Worker produces to it or consumes it',
	'kv-namespace': 'it contains keys'
};

/**
A bucket, queue or KV namespace with a name from the plan exists and is in
use, but none of the deployment's Workers uses it. Deploying would apply
cupboard's lifecycle rules to the bucket, consume the queue or write to the
namespace.
*/
export class UnrecognisedResourceError extends CliUsageError {
	constructor(
		public readonly kind: CheckedResourceKind,
		public readonly resource: string
	) {
		super(
			`The account has ${resourceDescriptions[kind]} called ${resource}, and ${resourceUses[kind]}, but none of this deployment's Workers uses it, so cupboard did not create it. ` +
				'Choose another --deployment-name, or another name in the plan. Nothing was changed.'
		);
		this.name = 'UnrecognisedResourceError';
	}
}

/**
The plan's custom domain is a custom domain of a Worker that is not one of
the deployment's Workers. Attaching the domain would take it from that
Worker.
*/
export class DomainServedByOtherWorkerError extends CliUsageError {
	constructor(
		public readonly hostname: string,
		public readonly worker: ScriptName
	) {
		super(
			`${hostname} is a custom domain of the Worker ${worker}, which does not belong to this deployment. ` +
				'Choose another domain, or remove the custom domain from that Worker first. Nothing was changed.'
		);
		this.name = 'DomainServedByOtherWorkerError';
	}
}

/**
The result of checking a plan against the account before the operator
approves it. `refusal` blocks the plan. `routeWorkers` lists the Workers
that routes in the domain's zone run in front of the deployment, which the
plan reports without blocking. An empty list means that no route in the zone
runs a Worker outside the deployment in front of the domain, or that the plan
has no domain. When the token cannot see the zone or may not list its routes,
`routeWorkers` is an `UncheckedRoutes` value that gives the reason.
*/
export interface PlanCheck {
	readonly refusal: CliUsageError | undefined;
	readonly routeWorkers: readonly ScriptName[] | UncheckedRoutes;
}

export type PlanCheckApi = Pick<
	CloudflareApi,
	| 'getScriptConfiguration'
	| 'findD1Database'
	| 'd1QueryRows'
	| 'findR2Bucket'
	| 'findQueue'
	| 'findKvNamespace'
	| 'findConsumerDeadLetterQueue'
	| 'findZoneId'
	| 'findHostnameWorkers'
> & {
	/**
	The bindings of the account's Workers other than the deployment's own. A
	deploy reads them at most once per run, and reads them again after a scan
	that failed.
	*/
	readonly accountWorkers: () => Promise<AccountWorkers>;
};

const uncheckedRoutesText: Record<
	UncheckedRoutes['kind'],
	(domain: string) => string
> = {
	'zone-unavailable': (domain) =>
		`The Cloudflare token cannot see a zone for ${domain}, so the plan cannot show which Workers run in front of the deployment. Give the token Zone: Read and Workers Routes: Read on that zone so that the plan can check the routes.`,
	'permission-denied': (domain) =>
		`The Cloudflare token may not list the Workers routes in the zone of ${domain}, so the plan cannot show which Workers run in front of the deployment. Give the token Workers Routes: Read on that zone so that the plan can check the routes.`
};

/**
The warning that the plan prints about the routes in the zone of its
`domain`, or `undefined` when there is none. It lists the route Workers that
run in front of the deployment. When the deploy could not list the routes, it
gives the reason. It returns `undefined` when the plan is refused for the
same hostname's zone or routes, because the refusal already gives that
reason.
*/
export function routesWarning(
	domain: string,
	check: PlanCheck
): string | undefined {
	const { refusal, routeWorkers } = check;

	if (areRoutesListed(routeWorkers)) {
		return routeWorkers.length === 0
			? undefined
			: `Routes in the zone of ${domain} run the Workers ${routeWorkers.join(', ')} in front of the deployment. The deploy leaves them unchanged.`;
	}

	const isRefusedForDomain =
		(refusal instanceof DomainZoneUnavailableError ||
			refusal instanceof RoutesPermissionRequiredError) &&
		refusal.hostname === domain;

	return isRefusedForDomain
		? undefined
		: uncheckedRoutesText[routeWorkers.kind](domain);
}

const cupboardServerBinding = z.looseObject({
	type: z.literal('durable_object_namespace'),
	class_name: z.literal('CupboardServer')
});

// D1 keeps internal tables whose names start with `_cf_`.
const userTablesQuery =
	"SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_';";

const appliedMigrationsQuery = 'SELECT name FROM d1_migrations;';

/**
The parts of the deployment artifact that the checks read: the Workers
configuration and the D1 migrations of each database.
*/
export type PlanArtifact = Pick<
	DeploymentArtifact,
	'config' | 'd1Migrations' | 'd1MigrationSets'
>;

const r2BucketBinding = z.looseObject({
	type: z.literal('r2_bucket'),
	bucket_name: z.string()
});
const queueBinding = z.looseObject({
	type: z.literal('queue'),
	queue_name: z.string()
});
const kvNamespaceBinding = z.looseObject({
	type: z.literal('kv_namespace'),
	namespace_id: z.string()
});

/**
A Worker of the plan, and the bindings that its deployed script reports, or
`undefined` when the script is not deployed.
*/
interface LiveWorker {
	readonly name: ScriptName;
	readonly bindings: readonly unknown[] | undefined;
}

async function liveWorkers(
	api: PlanCheckApi,
	config: DeploymentConfig
): Promise<LiveWorker[]> {
	return Promise.all(
		[config.control, config.tenant].map(async (worker) => {
			const live = await api.getScriptConfiguration(worker.name);

			return { name: worker.name, bindings: live?.bindings };
		})
	);
}

function unrecognisedWorker(
	workers: readonly LiveWorker[]
): CliUsageError | undefined {
	const unrecognised = workers.find(
		(worker) =>
			worker.bindings?.every(
				(binding) => !cupboardServerBinding.safeParse(binding).success
			) === true
	);

	return unrecognised === undefined
		? undefined
		: new UnrecognisedWorkerError(unrecognised.name);
}

function boundValues<T>(
	bindings: readonly unknown[],
	schema: z.ZodType<T>,
	value: (binding: T) => string
): Set<string> {
	const values = new Set<string>();

	for (const binding of bindings) {
		const parsed = schema.safeParse(binding);

		if (parsed.success) {
			values.add(value(parsed.data));
		}
	}

	return values;
}

/**
Refuses a bucket, queue or KV namespace with a name from the plan when it is
in use and none of the deployment's Workers uses it. An unused resource is
accepted, because the operator can create the bucket before a first deploy,
and a first deploy that stops before its upload leaves the others unused.
*/
async function unrecognisedResource(
	api: PlanCheckApi,
	config: DeploymentConfig,
	workers: readonly LiveWorker[],
	outsideUse: OutsideUse
): Promise<CliUsageError | undefined> {
	const bindings = workers.flatMap((worker) => worker.bindings ?? []);
	const ownBuckets = boundValues(
		bindings,
		r2BucketBinding,
		(binding) => binding.bucket_name
	);
	const deadLetters = await Promise.all(
		config.control.queueConsumers.map((consumer) =>
			api.findConsumerDeadLetterQueue(consumer.queue, config.control.name)
		)
	);
	const ownQueues = new Set([
		...boundValues(bindings, queueBinding, (binding) => binding.queue_name),
		...deadLetters.flatMap((queue) => queue ?? [])
	]);
	const ownNamespaces = boundValues(
		bindings,
		kvNamespaceBinding,
		(binding) => binding.namespace_id
	);
	const plannedWorkers = [config.control, config.tenant];
	const buckets = new Set(
		plannedWorkers.flatMap((worker) =>
			worker.r2Buckets.map((bucket) => bucket.bucketName)
		)
	);
	const queues = new Set(
		plannedWorkers.flatMap((worker) => [
			...worker.queueProducers.map((producer) => producer.queue),
			...worker.queueConsumers.flatMap((consumer) => [
				consumer.queue,
				...(consumer.deadLetterQueue === undefined
					? []
					: [consumer.deadLetterQueue])
			])
		])
	);
	const titles = new Set(
		plannedWorkers.flatMap((worker) =>
			worker.kvNamespaces.map((namespace) => namespace.title)
		)
	);

	for (const bucket of buckets) {
		const found = ownBuckets.has(bucket)
			? undefined
			: await api.findR2Bucket(bucket);

		if (found === undefined) {
			continue;
		}

		if (found.isUsed) {
			return new UnrecognisedResourceError('bucket', bucket);
		}

		const otherUse = await outsideUse('bucket', bucket, (bound) =>
			boundValues(bound, r2BucketBinding, (binding) => binding.bucket_name).has(
				bucket
			)
		);

		if (otherUse !== undefined) {
			return otherUse;
		}
	}

	for (const queue of queues) {
		const found = ownQueues.has(queue) ? undefined : await api.findQueue(queue);

		if (found === undefined) {
			continue;
		}

		if (found.isUsed) {
			return new UnrecognisedResourceError('queue', queue);
		}

		const deadLetterUser = found.deadLetterOf.find(
			(worker) => worker !== config.control.name
		);

		if (deadLetterUser !== undefined) {
			return new ResourceOfOtherWorkerError('queue', queue, deadLetterUser);
		}

		const otherUse = await outsideUse('queue', queue, (bound) =>
			boundValues(bound, queueBinding, (binding) => binding.queue_name).has(
				queue
			)
		);

		if (otherUse !== undefined) {
			return otherUse;
		}
	}

	for (const title of titles) {
		const namespace = await api.findKvNamespace(title);

		if (namespace?.isUsed === true && !ownNamespaces.has(namespace.id)) {
			return new UnrecognisedResourceError('kv-namespace', title);
		}
	}

	return undefined;
}

/**
The names of the release's migrations for the database with `binding`, in
the order that the deploy applies them.
*/
function migrationNames(artifact: PlanArtifact, binding: string): string[] {
	const migrations =
		artifact.d1MigrationSets?.[binding] ??
		(binding === 'CUPBOARD_DB' ? artifact.d1Migrations : []);

	return migrations
		.map((migration) => migration.name)
		.toSorted((left, right) => left.localeCompare(right));
}

function createdTableName(statement: string): string[] {
	const name = /^CREATE TABLE IF NOT EXISTS `?(\w+)`?/.exec(statement)?.[1];

	return name === undefined ? [] : [name];
}

/**
The tables that the deploy creates in a database before it records the
database's first migration. A first deploy that stops in between leaves
only these tables.
*/
export const bookkeepingTables: ReadonlySet<string> = new Set(
	[
		ensureTransitionTableStatement,
		ensurePhaseTableStatement,
		ensureTrackingTableStatement
	].flatMap((statement) => createdTableName(statement))
);

function boundDatabaseIds(bindings: readonly unknown[]): Set<string> {
	const ids = new Set<string>();

	for (const binding of bindings) {
		const parsed = liveD1BindingSchema.safeParse(binding);

		if (parsed.success) {
			ids.add(parsed.data.database_id);
		}
	}

	return ids;
}

async function unrecognisedDatabase(
	api: PlanCheckApi,
	artifact: PlanArtifact,
	workers: readonly LiveWorker[],
	outsideUse: OutsideUse
): Promise<CliUsageError | undefined> {
	const ownDatabases = boundDatabaseIds(
		workers.flatMap((worker) => worker.bindings ?? [])
	);

	for (const binding of deploymentD1Bindings(artifact.config)) {
		const id = await api.findD1Database(binding.databaseName);

		if (id === undefined) {
			continue;
		}

		const otherUse = ownDatabases.has(id)
			? undefined
			: await outsideUse('database', binding.databaseName, (bindings) =>
					boundDatabaseIds(bindings).has(id)
				);

		if (otherUse !== undefined) {
			return otherUse;
		}

		const migrations = migrationNames(artifact, binding.binding);
		const [first] = migrations;

		if (first === undefined) {
			continue;
		}

		const tables = await api.d1QueryRows(id, userTablesQuery);

		if (tables.length === 0) {
			continue;
		}

		const applied = tables.includes('d1_migrations')
			? await api.d1QueryRows(id, appliedMigrationsQuery)
			: [];

		const isStoppedFirstDeploy =
			tables.every((table) => bookkeepingTables.has(table)) &&
			applied.every((name) => migrations.includes(name));

		if (!isStoppedFirstDeploy && !applied.includes(first)) {
			return new UnrecognisedDatabaseError(binding.databaseName, first);
		}
	}

	return undefined;
}

/**
Checks the plan against the account before the operator approves it, and
refuses it when:

- a Worker, database, bucket, queue or KV namespace with one of the plan's
  names exists but does not belong to this deployment;
- the account's Workers cannot be listed or read, so that check cannot be
  completed;
- the plan's custom domain is a custom domain of another Worker;
- the token cannot see, in this account, the zone of a custom domain that
  the plan attaches or removes, because attaching needs the zone's ID and
  removing needs the Workers Routes: Edit permission on that zone;
- the token may not list the Workers routes in the zone of a custom domain
  that the plan attaches or removes, because changing it needs the Workers
  Routes: Edit permission there.

Routes do not take a domain from a custom-domain Worker, because Cloudflare
runs a route's Worker in front of it, so the routes of the plan's domain are
reported without blocking. `domainChange` is the plan's change to the
deployment's custom domains, or `undefined` when it keeps them.
*/
export async function checkPlan(
	api: PlanCheckApi,
	artifact: PlanArtifact,
	domain: string | undefined,
	domainChange: DomainChange | undefined
): Promise<PlanCheck> {
	const { config } = artifact;
	const own = new Set<string>([config.control.name, config.tenant.name]);
	const outsideUse = outsideUseLookup(api, own);
	const live = await liveWorkers(api, config);
	const resourceRefusal =
		unrecognisedWorker(live) ??
		(await unrecognisedDatabase(api, artifact, live, outsideUse)) ??
		(await unrecognisedResource(api, config, live, outsideUse));

	const removed =
		domainChange === undefined ? [] : removedDomains(domainChange);

	if (domain === undefined) {
		return {
			refusal: resourceRefusal ?? (await unchangeableDomain(api, removed)),
			routeWorkers: []
		};
	}

	const zoneId = await findHostnameZoneId(api, domain);
	const workers = await api.findHostnameWorkers(domain, zoneId);
	const isAttached =
		workers.customDomain === config.control.name &&
		domainChange?.kind !== 'first-domain' &&
		domainChange?.kind !== 'move';
	const otherWorkerRefusal =
		workers.customDomain === undefined || own.has(workers.customDomain)
			? undefined
			: new DomainServedByOtherWorkerError(domain, workers.customDomain);
	const attachRefusal = isAttached
		? undefined
		: zoneId === undefined
			? new DomainZoneUnavailableError(domain, 'attach')
			: uncheckedRoutesRefusal(domain, 'attach', workers.routes);

	return {
		refusal:
			resourceRefusal ??
			otherWorkerRefusal ??
			attachRefusal ??
			(await unchangeableDomain(api, removed)),
		routeWorkers: areRoutesListed(workers.routes)
			? workers.routes.filter((worker) => !own.has(worker))
			: workers.routes
	};
}

/**
Refuses the plan when the token cannot see the zone of a custom domain that
the plan removes, or may not list the Workers routes in it. Removing a
custom domain needs the Workers Routes: Edit permission on its zone.
*/
async function unchangeableDomain(
	api: PlanCheckApi,
	removed: readonly string[]
): Promise<CliUsageError | undefined> {
	for (const hostname of removed) {
		const zoneId = await findHostnameZoneId(api, hostname);

		if (zoneId === undefined) {
			return new DomainZoneUnavailableError(hostname, 'remove');
		}

		const workers = await api.findHostnameWorkers(hostname, zoneId);

		const refusal = uncheckedRoutesRefusal(hostname, 'remove', workers.routes);

		if (refusal !== undefined) {
			return refusal;
		}
	}

	return undefined;
}

/**
The refusal for a custom domain whose zone or routes the deploy could not
check, or `undefined` when it listed the routes.
*/
function uncheckedRoutesRefusal(
	hostname: string,
	action: CustomDomainAction,
	routes: readonly ScriptName[] | UncheckedRoutes
): CliUsageError | undefined {
	if (areRoutesListed(routes)) {
		return undefined;
	}

	switch (routes.kind) {
		case 'zone-unavailable': {
			return new DomainZoneUnavailableError(hostname, action);
		}
		case 'permission-denied': {
			return new RoutesPermissionRequiredError(hostname, action);
		}
	}
}
