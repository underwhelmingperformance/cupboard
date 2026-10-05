import type { Reporter, TestModule } from 'vitest/node';

export default class StrictEndToEndReporter implements Reporter {
	onTestRunEnd(modules: readonly TestModule[]): void {
		const skipped = modules.flatMap((module) =>
			[...module.children.allTests()]
				.filter((test) => test.result().state === 'skipped')
				.map((test) => `${module.moduleId}: ${test.fullName}`)
		);

		if (skipped.length === 0) {
			return;
		}

		throw new Error(
			`Unexpected skipped end-to-end tests:\n${skipped.join('\n')}`
		);
	}
}
