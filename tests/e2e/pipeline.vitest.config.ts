import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		fileParallelism: false,
		include: ['tests/e2e/publish-pipeline.test.ts'],
		// Each case runs a whole publication job: real evaluation, a real build,
		// and a cupboard subprocess for every planning and publishing step.
		hookTimeout: 600_000,
		testTimeout: 1_800_000
	}
});
