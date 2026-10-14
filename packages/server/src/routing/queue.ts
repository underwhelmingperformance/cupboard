import { rootLogger } from '@cupboard/logger';

import { type NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { boundedWorkerEnv } from '../do/bounded-io.ts';

import { ArtifactQueueConsumer } from './artifact-queue-consumer.ts';
import { artifactQueueHeaderSchema } from './artifact-queue-message.ts';
import { tenantServer } from './durable-object.ts';
import { handleMaintenanceQueueMessage } from './scheduled.ts';

/**
 * Routes messages to maintenance or artifact processing. Pass the raw Worker
 * environment so each processor applies its own I/O wrappers.
 */
export async function handleWorkerQueue(
	batch: MessageBatch,
	env: Env,
	buffers: NarReadBufferPool
): Promise<void> {
	const maintenanceEnv = boundedWorkerEnv(env);
	const logger = rootLogger().with({ worker: 'scheduled', queue: batch.queue });
	const artifacts = new ArtifactQueueConsumer({
		blobs: env.BLOBS,
		database: env.CUPBOARD_DB,
		buffers,
		queue: env.ARTIFACT_QUEUE,
		serverFor: (tenant) => tenantServer(env, tenant)
	});
	for (const message of batch.messages) {
		if (artifactQueueHeaderSchema.safeParse(message.body).success) {
			await artifacts.handleMessage(message);
			continue;
		}
		await handleMaintenanceQueueMessage(
			logger,
			maintenanceEnv,
			buffers,
			message
		);
	}
}
