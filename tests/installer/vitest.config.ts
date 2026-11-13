import { defineConfig, type ViteUserConfig } from 'vitest/config';

import { hangLimits } from '../support/hang-limits.ts';

import { compatibilityTests } from './required-tests.ts';
import RequiredInstallerTestsReporter from './required-tests-reporter.ts';

export default defineConfig((): ViteUserConfig => ({
	test: {
		include: ['tests/installer/compatibility.test.ts'],
		...hangLimits,
		fileParallelism: false,
		reporters: [
			'default',
			[
				'junit',
				{
					outputFile: `${process.env.TRIAL_RESULTS ?? '.tmp-installer-trial'}/compatibility.xml`
				}
			],
			new RequiredInstallerTestsReporter(compatibilityTests)
		]
	}
}));
