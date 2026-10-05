import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, vi } from 'vitest';

import { resetD1TestState } from './d1-test-reset.ts';
import {
	finishTestServerLifecycle,
	StalledMaintenancePassError
} from './test-support.ts';

// `TEST_MIGRATIONS` is typed in test-env.d.ts; vitest.config.ts supplies its
// value, and production applies the same files with `wrangler d1 migrations apply`.
// Setup files run outside per-test storage isolation and may run more than once;
// `applyD1Migrations` only applies what is outstanding, so the D1 schema is in
// place before any test touches `CUPBOARD_DB`.
await applyD1Migrations(env.CUPBOARD_DB, env.TEST_MIGRATIONS);

// Fresh Durable Objects do not isolate D1 between tests. Add new shared tables
// to resetD1TestState as the schema grows.
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

	await resetD1TestState(env.CUPBOARD_DB);

	// KV is shared across tests like D1. Clear the negative membership hints and
	// the cron's operational state so neither membership state nor the reaper's
	// demote-scan cursor leaks into the next test.
	for (const kv of [env.TENANT_CACHE, env.CRON_STATE]) {
		const { keys } = await kv.list();
		await Promise.all(keys.map((key) => kv.delete(key.name)));
	}
});

afterEach(async () => {
	// The test's Durable Objects are abandoned when it ends; an alarm left
	// armed on one would fire into an environment that has moved on, whose log
	// forwarding then races the pool's teardown. Quieten them first.
	// Use one registry snapshot for alarm cleanup and the stalled-pass audit. A
	// server selected earlier in the test must remain visible to both phases.
	const stalled = await finishTestServerLifecycle();
	const first = stalled[0];

	vi.useRealTimers();

	if (first !== undefined) {
		throw new StalledMaintenancePassError(first.pass, first.waitMs);
	}
});
