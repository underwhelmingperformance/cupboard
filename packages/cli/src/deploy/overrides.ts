import type { WorkersInvocationAllowance } from '@cupboard/protocol/platform';

import type {
	DeploymentConfig,
	EditableResourceKind,
	WorkerConfig
} from './config.ts';
import type { OwnerBinding } from './owner.ts';

type Renames = ReadonlyMap<string, string>;

function renameIn(value: string, renames: Renames): string {
	return renames.get(value) ?? value;
}

function renameBucketIn(worker: WorkerConfig, renames: Renames): WorkerConfig {
	return {
		...worker,
		r2Buckets: worker.r2Buckets.map((bucket) => ({
			...bucket,
			bucketName: renameIn(bucket.bucketName, renames)
		}))
	};
}

function renameDatabaseIn(
	worker: WorkerConfig,
	renames: Renames
): WorkerConfig {
	return {
		...worker,
		d1Databases: worker.d1Databases.map((database) => ({
			...database,
			databaseName: renameIn(database.databaseName, renames)
		}))
	};
}

function renameQueueIn(worker: WorkerConfig, renames: Renames): WorkerConfig {
	return {
		...worker,
		queueProducers: worker.queueProducers.map((producer) => ({
			...producer,
			queue: renameIn(producer.queue, renames)
		})),
		queueConsumers: worker.queueConsumers.map((consumer) => ({
			...consumer,
			queue: renameIn(consumer.queue, renames),
			deadLetterQueue:
				consumer.deadLetterQueue === undefined
					? undefined
					: renameIn(consumer.deadLetterQueue, renames)
		}))
	};
}

const renamers: Record<
	EditableResourceKind,
	(worker: WorkerConfig, renames: Renames) => WorkerConfig
> = {
	bucket: renameBucketIn,
	database: renameDatabaseIn,
	queue: renameQueueIn
};

/**
 * Renames resources of one kind everywhere both Workers reference them, so
 * bindings, producers, consumers and dead-letter queues stay consistent. The
 * renames apply at once, so one never feeds another. Names that are not keys
 * of `renames` are untouched.
 */
export function renameResources(
	config: DeploymentConfig,
	kind: EditableResourceKind,
	renames: Renames
): DeploymentConfig {
	if (renames.size === 0) {
		return config;
	}

	const rename = renamers[kind];

	return {
		control: rename(config.control, renames),
		tenant: rename(config.tenant, renames)
	};
}

/**
 * Renames one resource everywhere both Workers reference it.
 */
export function renameResource(
	config: DeploymentConfig,
	kind: EditableResourceKind,
	from: string,
	to: string
): DeploymentConfig {
	return renameResources(config, kind, new Map([[from, to]]));
}

/**
 * Sets the KV namespace titles by binding name, in both Workers. Bindings
 * that are not keys of `titles` keep their title.
 */
export function withKvTitles(
	config: DeploymentConfig,
	titles: ReadonlyMap<string, string>
): DeploymentConfig {
	if (titles.size === 0) {
		return config;
	}

	const retitle = (worker: WorkerConfig): WorkerConfig => ({
		...worker,
		kvNamespaces: worker.kvNamespaces.map((namespace) => ({
			...namespace,
			title: titles.get(namespace.binding) ?? namespace.title
		}))
	});

	return { control: retitle(config.control), tenant: retitle(config.tenant) };
}

export function withCrons(
	config: DeploymentConfig,
	crons: readonly string[]
): DeploymentConfig {
	return {
		...config,
		control: { ...config.control, crons }
	};
}

/**
 * Sets the OIDC identity allowed to claim global admin. Passing no identity
 * writes empty values and closes the signup gate. A configured
 * `CUPBOARD_SIGNUP_SECRET` takes precedence over this identity.
 */
export function withSignupGate(
	config: DeploymentConfig,
	admin?: OwnerBinding
): DeploymentConfig {
	const variables = {
		CUPBOARD_SIGNUP_ISSUER: admin?.issuer ?? '',
		CUPBOARD_SIGNUP_AUDIENCE: admin?.audience ?? '',
		CUPBOARD_SIGNUP_SUBJECT: admin?.subject ?? ''
	};

	return {
		...config,
		control: {
			...config.control,
			vars: { ...config.control.vars, ...variables }
		}
	};
}

/**
 * Sets the shared D1 and R2 subrequest allowance for both Workers.
 */
export function withWorkersInvocationAllowance(
	config: DeploymentConfig,
	allowance: WorkersInvocationAllowance
): DeploymentConfig {
	const variables = {
		CUPBOARD_SUBREQUESTS_PER_INVOCATION: String(allowance.subrequests)
	};

	return {
		control: {
			...config.control,
			vars: { ...config.control.vars, ...variables }
		},
		tenant: { ...config.tenant, vars: { ...config.tenant.vars, ...variables } }
	};
}
