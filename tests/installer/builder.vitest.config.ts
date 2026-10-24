import { defineConfig, type ViteUserConfig } from 'vitest/config';

import RequiredInstallerTestsReporter from './required-tests-reporter.ts';

export default defineConfig((): ViteUserConfig => ({
	test: {
		include: ['tests/installer/remote-builder.test.ts'],
		fileParallelism: false,
		hookTimeout: 120_000,
		testTimeout: 180_000,
		reporters: [
			'default',
			[
				'junit',
				{
					outputFile: `${process.env.TRIAL_RESULTS ?? '.tmp-installer-trial'}/builder.xml`
				}
			],
			new RequiredInstallerTestsReporter([
				'copies inputs and outputs through a separate builder while observing the completed build'
			])
		]
	}
}));
