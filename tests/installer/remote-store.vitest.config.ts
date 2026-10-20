import { defineConfig, mergeConfig } from 'vitest/config';

import remoteStore from '../e2e/remote-store.vitest.config.ts';

import { remoteStoreTests } from './required-tests.ts';
import RequiredInstallerTestsReporter from './required-tests-reporter.ts';

export default mergeConfig(
	remoteStore,
	defineConfig({
		test: {
			reporters: [
				'default',
				[
					'junit',
					{
						outputFile: `${process.env.TRIAL_RESULTS ?? '.tmp-installer-trial'}/remote-store.xml`
					}
				],
				new RequiredInstallerTestsReporter(remoteStoreTests)
			]
		}
	})
);
