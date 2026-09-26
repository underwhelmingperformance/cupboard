import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { maintenanceQueueMaxRetries } from '../packages/server/src/policy/maintenance-queue.ts';

const wranglerConfiguration = path.join(
	import.meta.dirname,
	'..',
	'packages/server/wrangler.jsonc'
);

const queueConsumerSchema = z.object({
	queue: z.string(),
	max_retries: z.number().optional()
});
const queueConsumersSchema = z.object({
	queues: z.object({ consumers: z.array(queueConsumerSchema) })
});

describe('the maintenance queue consumer', () => {
	it('configures the max_retries that the local-step sweep lease assumes', () => {
		const text = readFileSync(wranglerConfiguration, 'utf8');
		const parsed = ts.parseConfigFileTextToJson(wranglerConfiguration, text);
		const json: unknown = parsed.config;
		const consumers = queueConsumersSchema
			.parse(json)
			.queues.consumers.filter(
				(consumer) => consumer.queue === 'cupboard-maintenance'
			);

		expect({ error: parsed.error, consumers }).toStrictEqual({
			error: undefined,
			consumers: [
				{
					queue: 'cupboard-maintenance',
					max_retries: maintenanceQueueMaxRetries
				}
			]
		});
	});
});
