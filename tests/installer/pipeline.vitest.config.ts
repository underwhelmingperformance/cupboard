import { defineConfig, mergeConfig } from 'vitest/config';

import pipeline from '../e2e/pipeline.vitest.config.ts';

import { pipelineTests } from './required-tests.ts';
import RequiredInstallerTestsReporter from './required-tests-reporter.ts';

export default mergeConfig(
	pipeline,
	defineConfig({
		test: {
			...(process.platform === 'darwin' && {
				testNamePattern: /^(?!.*against an ssh-ng remote store)/u
			}),
			reporters: [
				'default',
				[
					'junit',
					{
						outputFile: `${process.env.TRIAL_RESULTS ?? '.tmp-installer-trial'}/pipeline.xml`
					}
				],
				new RequiredInstallerTestsReporter(pipelineTests)
			]
		}
	})
);
