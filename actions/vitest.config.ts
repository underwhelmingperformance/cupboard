import { defineConfig } from 'vitest/config';

import { hangLimits } from '../tests/support/hang-limits.ts';

export default defineConfig({
	test: {
		...hangLimits,
		include: ['actions/src/**/*.test.ts'],
		setupFiles: ['tests/support/action-test-environment.ts']
	}
});
