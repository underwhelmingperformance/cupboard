import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// The schema suites exercise the contract's own caps, building request
		// bodies of a hundred thousand paths and parsing every one, so a test here
		// waits on that work rather than on its own assertions. They get the budget
		// the server's suites get.
		testTimeout: 30_000
	}
});
