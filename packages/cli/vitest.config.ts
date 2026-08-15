import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		setupFiles: ['./src/network-guard-test-setup.ts']
	}
});
