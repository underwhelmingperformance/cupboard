import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach } from 'vitest';

import {
	blobReference,
	blobState,
	controlAuthKey,
	controlTrust,
	globalAdmin,
	tenant,
	tenantBlob
} from './db/d1-schema.ts';

// `TEST_MIGRATIONS` is typed in test-env.d.ts; vitest.config.ts supplies its
// value, and production applies the same files with `wrangler d1 migrations apply`.
// Setup files run outside per-test storage isolation and may run more than once;
// `applyD1Migrations` only applies what is outstanding, so the D1 schema is in
// place before any test touches `CUPBOARD_DB`.
await applyD1Migrations(env.CUPBOARD_DB, env.TEST_MIGRATIONS);

// D1 is a single shared binding the pool does not roll back between tests (the
// per-test reset other state relies on — a fresh Durable Object via
// resetTestServer — leaves D1 untouched). Wiping the global facts before each
// test gives every test the empty shared store it expects. Every D1 table must
// be cleared here; add new ones as the schema grows.
beforeEach(async () => {
	const database = drizzle(env.CUPBOARD_DB);
	await database.delete(blobReference).run();
	await database.delete(tenantBlob).run();
	await database.delete(blobState).run();
	await database.delete(controlAuthKey).run();
	await database.delete(controlTrust).run();
	await database.delete(globalAdmin).run();
	await database.delete(tenant).run();
});
