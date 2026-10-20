import { byCodeUnit } from '@cupboard/nix-store/store-path';
import type { Reporter, TestModule } from 'vitest/node';

export default class RequiredInstallerTestsReporter implements Reporter {
	constructor(private readonly expectedTests?: readonly string[]) {}

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
		if (this.expectedTests !== undefined) {
			const expected = this.expectedTests
				.filter(
					(name) =>
						!(
							process.platform === 'darwin' &&
							name.includes('against an ssh-ng remote store')
						)
				)
				.toSorted(byCodeUnit);
			const actual = required.map((test) => test.fullName).toSorted(byCodeUnit);
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				throw new Error(
					`The installer trial test inventory changed. Expected ${JSON.stringify(expected)}, collected ${JSON.stringify(actual)}`
				);
			}
		}
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
