import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		hookTimeout: 1_800_000,
		testTimeout: 1_800_000
	}
});
