import { defineConfig } from 'vitest/config';

import { hangLimits } from '../support/hang-limits.ts';
import StrictEndToEndReporter from '../support/strict-e2e-reporter.ts';

export default defineConfig(() => ({
	test: {
		...hangLimits,
		globalSetup: ['tests/support/e2e-artifacts.global-setup.ts'],
		setupFiles: ['tests/support/e2e-artifacts.setup.ts'],
		reporters:
			process.env.CI !== undefined && process.platform === 'linux'
				? ['default', new StrictEndToEndReporter()]
				: ['default'],
		exclude: [
			'tests/e2e/publish-pipeline.test.ts',
			'tests/e2e/remote-nix-store.test.ts'
		],
		fileParallelism: false,
		include: ['tests/e2e/**/*.test.ts', 'tests/support/**/*.test.ts']
	}
}));
