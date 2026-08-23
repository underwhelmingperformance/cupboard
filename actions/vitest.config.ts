import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// These tests launch the action as a real subprocess and create filesystem
		// fixtures. Give process startup and I/O the same 30-second budget as the
		// server suites.
		include: ['actions/src/**/*.test.ts'],
		testTimeout: 30_000
	}
});
