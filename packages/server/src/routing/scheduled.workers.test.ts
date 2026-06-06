import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	provisionNamedTenant,
	resetTestServer,
	suspendTenant
} from '../test-support.ts';

import { runCronSweep } from './scheduled.ts';

describe('scheduled tenant maintenance', () => {
	beforeEach(resetTestServer);

	it('bounds concurrent tenant maintenance passes', async () => {
		for (const tenant of ['acme', 'beta', 'gamma', 'delta', 'epsilon']) {
			await provisionNamedTenant(tenant);
		}
		await suspendTenant('v1');

		let active = 0;
		let maxActive = 0;
		const seen: string[] = [];

		await runCronSweep(env, 5, async (_env, id) => {
			seen.push(id);
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 0));
			active -= 1;
		});

		expect({ seen, maxActive }).toStrictEqual({
			seen: ['acme', 'beta', 'delta', 'epsilon', 'gamma'],
			maxActive: 4
		});
	});
});
