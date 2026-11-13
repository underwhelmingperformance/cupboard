import { defineConfig } from 'vitest/config';

import { hangLimits } from '../support/hang-limits.ts';

export default defineConfig({
	test: {
		...hangLimits,
		globalSetup: ['tests/support/e2e-artifacts.global-setup.ts'],
		setupFiles: ['tests/support/e2e-artifacts.setup.ts'],
		fileParallelism: false,
		include: ['tests/e2e/remote-nix-store.test.ts']
	}
});
