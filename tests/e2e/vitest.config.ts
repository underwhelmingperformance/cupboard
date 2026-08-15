import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		exclude: [
			'tests/e2e/publish-pipeline.test.ts',
			'tests/e2e/remote-nix-store.test.ts'
		],
		fileParallelism: false,
		include: ['tests/e2e/**/*.test.ts', 'tests/support/**/*.test.ts'],
		testTimeout: 120_000
	}
});
