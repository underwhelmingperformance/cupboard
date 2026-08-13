import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		fileParallelism: false,
		include: ['tests/e2e/remote-nix-store.test.ts'],
		testTimeout: 120_000
	}
});
