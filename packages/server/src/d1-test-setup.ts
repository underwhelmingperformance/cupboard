import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, vi } from 'vitest';

import {
	attestationReference,
	blobReference,
	blobState,
	casObject,
	controlAuthKey,
	controlTrust,
	globalAdmin,
	manifestState,
	tenant,
	tenantBlob,
	tenantCasBlob,
	tenantMaintenanceEligibility,
	tenantMaintenanceFailure,
	tenantUsage
} from './db/d1-schema.ts';
import { clearAbandonedAlarms } from './test-support.ts';

// `TEST_MIGRATIONS` is typed in test-env.d.ts; vitest.config.ts supplies its
// value, and production applies the same files with `wrangler d1 migrations apply`.
// Setup files run outside per-test storage isolation and may run more than once;
// `applyD1Migrations` only applies what is outstanding, so the D1 schema is in
// place before any test touches `CUPBOARD_DB`.
await applyD1Migrations(env.CUPBOARD_DB, env.TEST_MIGRATIONS);

// D1 is a single shared binding the pool does not roll back between tests (the
// per-test reset other state relies on, specifically a fresh Durable Object via
// resetTestServer, leaves D1 untouched). Wiping the global facts before each
// test gives every test the empty shared store it expects. Every D1 table must
// be cleared here; add new ones as the schema grows.
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

	const database = drizzle(env.CUPBOARD_DB);
	await database.delete(attestationReference).run();
	await database.delete(blobReference).run();
	await database.delete(tenantCasBlob).run();
	await database.delete(tenantBlob).run();
	await database.delete(tenantMaintenanceEligibility).run();
	await database.delete(tenantMaintenanceFailure).run();
	await database.delete(tenantUsage).run();
	await database.delete(casObject).run();
	await database.delete(blobState).run();
	await database.delete(controlAuthKey).run();
	await database.delete(controlTrust).run();
	await database.delete(globalAdmin).run();
	await database.delete(tenant).run();
	await database.delete(manifestState).run();

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
	await clearAbandonedAlarms();

	vi.useRealTimers();
});
