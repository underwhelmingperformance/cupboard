import { defineConfig } from 'vitest/config';

import { hangLimits } from '../../tests/support/hang-limits.ts';

export default defineConfig({
	test: {
		...hangLimits
	}
});
