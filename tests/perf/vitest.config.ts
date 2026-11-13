import { defineConfig } from 'vitest/config';

import { hangLimits } from '../support/hang-limits.ts';

export default defineConfig({
	test: {
		...hangLimits,
		fileParallelism: false,
		benchmark: {
			include: ['tests/perf/**/*.bench.ts']
		}
	}
});
