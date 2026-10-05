import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globalSetup: ['tests/support/e2e-artifacts.global-setup.ts'],
		setupFiles: ['tests/support/e2e-artifacts.setup.ts'],
		fileParallelism: false,
		include: ['tests/e2e/remote-nix-store.test.ts'],
		testTimeout: 120_000
	}
});
