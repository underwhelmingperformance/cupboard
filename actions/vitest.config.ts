import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// The suites drive the action's entrypoint as a real subprocess and stage
		// their fixtures under the runner's temporary directory, so a test here
		// waits on process startup and filesystem work rather than on its own
		// assertions. They get the budget the server's suites get.
		include: ['actions/src/**/*.test.ts'],
		testTimeout: 30_000
	}
});
