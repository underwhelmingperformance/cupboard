import type { Reporter, TestModule } from 'vitest/node';

export default class RequiredInstallerTestsReporter implements Reporter {
	onTestRunEnd(modules: readonly TestModule[]): void {
		const required = modules
			.flatMap((module) => [...module.children.allTests()])
			.filter(
				(test) =>
					!(
						process.platform === 'darwin' &&
						test.fullName.includes('against an ssh-ng remote store')
					)
			);
		if (required.length === 0) {
			throw new Error('The installer trial ran no required tests');
		}
		const skipped = required
			.filter((test) => test.result().state === 'skipped')
			.map((test) => test.fullName);
		if (skipped.length > 0) {
			throw new Error(
				`Required installer trial tests were skipped:\n${skipped.join('\n')}`
			);
		}
	}
}
