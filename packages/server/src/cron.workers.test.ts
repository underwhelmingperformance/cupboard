import { beforeEach, describe, expect, it } from 'vitest';

import { currentServer, resetTestServer } from './test-support.ts';

describe('cron maintenance RPC', () => {
	beforeEach(resetTestServer);

	// The scheduled Worker drives maintenance by calling these Durable Object
	// methods directly, not over HTTP, so they carry no bearer token. Each
	// initialises the DO and completes a pass against the empty store.
	it('runs garbage collection and verification through unauthenticated RPC', async () => {
		const stub = currentServer();

		await expect(stub.runGarbageCollection()).resolves.toBeUndefined();
		await expect(stub.runVerification()).resolves.toBeUndefined();
	});
});
