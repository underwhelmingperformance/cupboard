import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		fileParallelism: false,
		include: ['tests/e2e/**/*.test.ts', 'tests/support/**/*.test.ts'],
		testTimeout: 120_000
	}
});
