import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: './src/worker.ts',
			wrangler: {
				configPath: './wrangler.toml'
			}
		})
	],
	test: {
		fileParallelism: false,
		include: ['src/**/*.test.ts'],
		testTimeout: 30_000
	}
});
