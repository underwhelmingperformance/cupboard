import { beforeEach, describe, expect, it } from 'vitest';

import { currentServer, resetTestServer } from '../test-support.ts';

describe('cron maintenance RPC', () => {
	beforeEach(resetTestServer);

	// The scheduled Worker calls these Durable Object methods directly, without
	// an HTTP bearer token. Each method must initialise the object before it runs.
	it('runs both maintenance passes through unauthenticated RPC', async () => {
		const stub = currentServer();

		await expect(stub.runGarbageCollection()).resolves.toBeUndefined();
		await expect(stub.runVerification()).resolves.toBeUndefined();
	});
});
