import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { maintenanceQueueMaxRetries } from '../packages/server/src/routing/maintenance-queue.ts';

const wranglerConfiguration = path.join(
	import.meta.dirname,
	'..',
	'packages/server/wrangler.jsonc'
);

describe('the maintenance queue consumer', () => {
	it('retries as many times as the local-step sweep lease allows for', () => {
		const text = readFileSync(wranglerConfiguration, 'utf8');
		const retries = text
			.matchAll(/"max_retries":\s*(\d+)/gu)
			.map((match) => Number(match[1]))
			.toArray();

		expect(retries).toStrictEqual([maintenanceQueueMaxRetries]);
	});
});
