import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	cloudflareTest,
	readD1Migrations
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
	// The D1 migrations production applies through `wrangler d1 migrations apply`,
	// handed to the workers pool as a binding the setup file replays into D1.
	const here = path.dirname(fileURLToPath(import.meta.url));
	const migrations = await readD1Migrations(path.join(here, 'drizzle-d1'));

	return {
		test: {
			testTimeout: 30_000,
			projects: [
				{
					test: {
						name: 'node',
						sequence: { groupOrder: 0 },
						benchmark: {
							include: ['src/**/*.bench.ts']
						},
						include: ['src/**/*.test.ts'],
						exclude: ['src/**/*.workers.test.ts']
					}
				},
				{
					plugins: [
						cloudflareTest({
							// The Durable Object must live in the `main` worker for
							// `runInDurableObject` to reach it, so the tenant script is the
							// worker under test; the control handler is exercised by calling
							// its exported `fetch` directly (see `controlFetch`). The
							// control-plane bindings are deliberately not bound here, so the
							// Durable Object's env lacks them exactly as in production.
							main: './src/tenant-worker.ts',
							miniflare: {
								bindings: {
									R2_ACCESS_KEY_ID: 'test-access-key-id',
									R2_ACCOUNT_ID: 'test-account-id',
									R2_BUCKET_NAME: 'cupboard-blobs',
									R2_SECRET_ACCESS_KEY: 'test-secret-access-key',
									PUSH_ID_SIGNING_KEY: 'test-push-id-signing-key',
									S3_SECRET_KEY: Buffer.from(
										'0123456789abcdef0123456789abcdef'
									).toString('base64'),
									TEST_MIGRATIONS: migrations
								},
								// The admission manifest KV the control handler reads and writes;
								// it is control-plane state, supplied to the worker under test so
								// the control handler can be exercised through it.
								kvNamespaces: {
									TENANT_CACHE: 'tenant-cache',
									CRON_STATE: 'cron-state'
								},
								queueProducers: {
									MAINTENANCE_QUEUE: 'cupboard-maintenance'
								},
								compatibilityDate: '2026-04-28'
							},
							wrangler: {
								configPath: './wrangler.tenant.jsonc'
							}
						})
					],
					test: {
						name: 'workers',
						fileParallelism: true,
						maxWorkers: 4,
						sequence: { groupOrder: 1 },
						include: ['src/**/*.workers.test.ts'],
						setupFiles: ['./src/d1-test-setup.ts']
					}
				}
			]
		}
	};
});
