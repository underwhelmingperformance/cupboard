import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// No test has its own time limit. These values only end a hung run.
		hookTimeout: 1_800_000,
		setupFiles: ['./src/network-guard-test-setup.ts'],
		testTimeout: 1_800_000
	}
});
