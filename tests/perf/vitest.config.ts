import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		fileParallelism: false,
		hookTimeout: 600_000,
		testTimeout: 600_000,
		benchmark: {
			include: ['tests/perf/**/*.bench.ts']
		}
	}
});
