import { rootLogger } from '@cupboard/logger';

import { type NarReadBufferPool } from '../blob/nar-read-buffers.ts';
import { boundedWorkerEnv } from '../do/bounded-io.ts';

import { ArtifactQueueConsumer } from './artifact-queue-consumer.ts';
import { artifactQueueHeaderSchema } from './artifact-queue-message.ts';
import { tenantServer } from './durable-object.ts';
import { ListingAdoptionQueue } from './listing-adoption-queue.ts';
import {
	listingAdoptionQueueHeaderSchema,
	listingAdoptionQueueMessageSchema
} from './listing-adoption-queue-message.ts';
import { listingAdoptionWorkHeaderSchema } from './listing-adoption-work-message.ts';
import { ListingAdoptionWorkQueue } from './listing-adoption-work-queue.ts';
import { handleMaintenanceQueueMessage } from './scheduled.ts';
import { sharedListingCleanupHeaderSchema } from './shared-listing-cleanup-message.ts';
import { SharedListingCleanupQueue } from './shared-listing-cleanup-queue.ts';
import { SharedListingQueue } from './shared-listing-queue.ts';
import { sharedListingQueueHeaderSchema } from './shared-listing-queue-message.ts';

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
	const sharedCleanup = new SharedListingCleanupQueue({
		database: env.CUPBOARD_DB,
		blobs: env.BLOBS,
		queue: env.ARTIFACT_QUEUE
	});
	const listings = new SharedListingQueue({
		database: env.CUPBOARD_DB,
		blobs: env.BLOBS,
		queue: env.ARTIFACT_QUEUE,
		buffers
	});
	const adoption = new ListingAdoptionQueue({
		database: env.CUPBOARD_DB,
		queue: env.ARTIFACT_QUEUE
	});
	const adoptionWork = new ListingAdoptionWorkQueue({
		database: env.CUPBOARD_DB,
		queue: env.ARTIFACT_QUEUE,
		wakeHistorical: () =>
			env.ARTIFACT_QUEUE.send({ kind: 'listing-adoption-dispatch' }),
		serverFor: (tenant) => tenantServer(env, tenant)
	});
	for (const message of batch.messages) {
		if (listingAdoptionWorkHeaderSchema.safeParse(message.body).success) {
			await adoptionWork.handleMessage(message);
			continue;
		}
		if (listingAdoptionQueueHeaderSchema.safeParse(message.body).success) {
			await adoption.handleMessage(message);
			if (listingAdoptionQueueMessageSchema.safeParse(message.body).success) {
				try {
					await adoptionWork.start();
				} catch (error) {
					logger.warn(
						'listing adoption work wake failed; cron recovery remains due',
						{ messageId: message.id, error }
					);
				}
			}

			continue;
		}
		if (sharedListingQueueHeaderSchema.safeParse(message.body).success) {
			await listings.handleMessage(message);
			continue;
		}
		if (sharedListingCleanupHeaderSchema.safeParse(message.body).success) {
			await sharedCleanup.handleMessage(message);
			continue;
		}
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
