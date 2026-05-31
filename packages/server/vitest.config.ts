import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		fileParallelism: false,
		testTimeout: 30_000,
		projects: [
			{
				test: {
					name: 'node',
					include: ['src/**/*.test.ts'],
					exclude: ['src/**/*.workers.test.ts']
				}
			},
			{
				plugins: [
					cloudflareTest({
						main: './src/worker.ts',
						miniflare: {
							bindings: {
								CUPBOARD_BOOTSTRAP_TOKEN: 'test-bootstrap',
								R2_ACCESS_KEY_ID: 'test-access-key-id',
								R2_ACCOUNT_ID: 'test-account-id',
								R2_SECRET_ACCESS_KEY: 'test-secret-access-key'
							},
							compatibilityDate: '2026-04-28'
						},
						wrangler: {
							configPath: './wrangler.toml'
						}
					})
				],
				test: {
					name: 'workers',
					include: ['src/**/*.workers.test.ts']
				}
			}
		]
	}
});
