import type {
	DeploymentConfig,
	EditableResourceKind,
	WorkerConfig
} from './config.ts';

function renameIn(value: string, from: string, to: string): string {
	return value === from ? to : value;
}

function renameBucketIn(
	worker: WorkerConfig,
	from: string,
	to: string
): WorkerConfig {
	return {
		...worker,
		r2Buckets: worker.r2Buckets.map((bucket) => ({
			...bucket,
			bucketName: renameIn(bucket.bucketName, from, to)
		}))
	};
}

function renameDatabaseIn(
	worker: WorkerConfig,
	from: string,
	to: string
): WorkerConfig {
	return {
		...worker,
		d1Databases: worker.d1Databases.map((database) => ({
			...database,
			databaseName: renameIn(database.databaseName, from, to)
		}))
	};
}

function renameQueueIn(
	worker: WorkerConfig,
	from: string,
	to: string
): WorkerConfig {
	return {
		...worker,
		queueProducers: worker.queueProducers.map((producer) => ({
			...producer,
			queue: renameIn(producer.queue, from, to)
		})),
		queueConsumers: worker.queueConsumers.map((consumer) => ({
			...consumer,
			queue: renameIn(consumer.queue, from, to),
			deadLetterQueue:
				consumer.deadLetterQueue === undefined
					? undefined
					: renameIn(consumer.deadLetterQueue, from, to)
		}))
	};
}

const renamers: Record<
	EditableResourceKind,
	(worker: WorkerConfig, from: string, to: string) => WorkerConfig
> = {
	bucket: renameBucketIn,
	database: renameDatabaseIn,
	queue: renameQueueIn
};

/**
 * Renames a resource everywhere both Workers reference it, so bindings,
 * producers, consumers and dead-letter queues stay consistent. Names not
 * matching `from` are untouched.
 */
export function renameResource(
	config: DeploymentConfig,
	kind: EditableResourceKind,
	from: string,
	to: string
): DeploymentConfig {
	const rename = renamers[kind];

	return {
		control: rename(config.control, from, to),
		tenant: rename(config.tenant, from, to)
	};
}

/** Replaces the control Worker's cron triggers (the tenant has none). */
export function withCrons(
	config: DeploymentConfig,
	crons: readonly string[]
): DeploymentConfig {
	return {
		...config,
		control: { ...config.control, crons }
	};
}
