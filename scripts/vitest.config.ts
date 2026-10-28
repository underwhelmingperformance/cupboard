import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		setupFiles: ['tests/support/action-test-environment.ts'],
		testTimeout: 1_800_000
	}
});
