import { defineConfig } from 'vitest/config';

import RequiredInstallerTestsReporter from './required-tests-reporter.ts';

export default defineConfig({
	test: {
		include: ['tests/installer/compatibility.test.ts'],
		fileParallelism: false,
		hookTimeout: 120_000,
		testTimeout: 180_000,
		reporters: [
			'default',
			[
				'junit',
				{
					outputFile: `${process.env.TRIAL_RESULTS ?? '.tmp-installer-trial'}/compatibility.xml`
				}
			],
			new RequiredInstallerTestsReporter()
		]
	}
});
