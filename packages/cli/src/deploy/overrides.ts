import type { WorkersInvocationAllowance } from '@cupboard/protocol/platform';

import {
	type DeploymentConfig,
	type EditableResourceKind,
	editableResourceKinds,
	type WorkerConfig
} from './config.ts';
import type { OwnerBinding } from './owner.ts';

type Rename = (name: string) => string;

function renameBucketIn(worker: WorkerConfig, rename: Rename): WorkerConfig {
	return {
		...worker,
		r2Buckets: worker.r2Buckets.map((bucket) => ({
			...bucket,
			bucketName: rename(bucket.bucketName)
		}))
	};
}

function renameDatabaseIn(worker: WorkerConfig, rename: Rename): WorkerConfig {
	return {
		...worker,
		d1Databases: worker.d1Databases.map((database) => ({
			...database,
			databaseName: rename(database.databaseName)
		}))
	};
}

function renameQueueIn(worker: WorkerConfig, rename: Rename): WorkerConfig {
	return {
		...worker,
		queueProducers: worker.queueProducers.map((producer) => ({
			...producer,
			queue: rename(producer.queue)
		})),
		queueConsumers: worker.queueConsumers.map((consumer) => ({
			...consumer,
			queue: rename(consumer.queue),
			deadLetterQueue:
				consumer.deadLetterQueue === undefined
					? undefined
					: rename(consumer.deadLetterQueue)
		}))
	};
}

const renamers: Record<
	EditableResourceKind,
	(worker: WorkerConfig, rename: Rename) => WorkerConfig
> = {
	bucket: renameBucketIn,
	database: renameDatabaseIn,
	queue: renameQueueIn
};

type ResourceRenames = Partial<
	Record<EditableResourceKind, ReadonlyMap<string, string>>
>;

/**
 * Renames resources in every binding, producer, consumer and dead-letter queue
 * of both Workers. For each kind,
 * `renames` maps an old name to its new name. Each reference is looked up once
 * against the old names, so a new name that equals another old name is not
 * renamed again. Names without an entry are untouched.
 */
export function renameResources(
	config: DeploymentConfig,
	renames: ResourceRenames
): DeploymentConfig {
	let renamed = config;

	for (const kind of editableResourceKinds) {
		const names = renames[kind];

		if (names === undefined) {
			continue;
		}

		const renameWorker = renamers[kind];
		const rename = (name: string): string => names.get(name) ?? name;

		renamed = {
			control: renameWorker(renamed.control, rename),
			tenant: renameWorker(renamed.tenant, rename)
		};
	}

	return renamed;
}

/**
 * Renames one resource everywhere both Workers reference it. Names not
 * matching `from` are untouched.
 */
export function renameResource(
	config: DeploymentConfig,
	kind: EditableResourceKind,
	from: string,
	to: string
): DeploymentConfig {
	return renameResources(config, { [kind]: new Map([[from, to]]) });
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
