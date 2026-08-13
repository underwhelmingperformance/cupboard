import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		fileParallelism: false,
		include: ['tests/conformance/**/*.test.ts'],
		testTimeout: 120_000
	}
});
