import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	collectVerificationPasses,
	currentServer,
	initialise,
	resetTestServer,
	testBase
} from '../test-support.ts';

import { verifyRequestStaleMs } from './commit-pipeline-service.ts';

describe('verify request staleness guard', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();
	});

	it('suppresses a fresh duplicate and re-sends once stale', async () => {
		await initialise();
		const sent = await collectVerificationPasses();
		const request = { kind: 'tenant-verify', tenant: fixtureTenant };

		await currentServer().requestVerificationPass();
		vi.setSystemTime(new Date(testBase.getTime() + verifyRequestStaleMs - 1));
		await currentServer().requestVerificationPass();

		expect(sent).toStrictEqual([request]);

		vi.setSystemTime(new Date(testBase.getTime() + verifyRequestStaleMs));
		await currentServer().requestVerificationPass();

		expect(sent).toStrictEqual([request, request]);
	});

	it('retries at once after a failed send', async () => {
		await initialise();

		const sent: unknown[] = [];
		const metrics = { backlogCount: 0, backlogBytes: 0 };
		let shouldFail = true;

		await runInDurableObject(currentServer(), (instance) => {
			instance.context.env = {
				...instance.context.env,
				MAINTENANCE_QUEUE: {
					send: (message: unknown) => {
						if (shouldFail) {
							shouldFail = false;

							return Promise.reject(new Error('queue outage'));
						}

						sent.push(message);

						return Promise.resolve({ metadata: { metrics } });
					},
					sendBatch: () => Promise.resolve({ metadata: { metrics } }),
					metrics: () => Promise.resolve(metrics)
				}
			};

			return Promise.resolve();
		});

		await currentServer().requestVerificationPass();

		expect(sent).toStrictEqual([]);

		await currentServer().requestVerificationPass();

		expect(sent).toStrictEqual([
			{ kind: 'tenant-verify', tenant: fixtureTenant }
		]);
	});
});
