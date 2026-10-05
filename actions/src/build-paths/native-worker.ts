import { buildAction, type BuildDependencies } from '../commands/build.ts';

import { buildPathInputs, runNativeBuild } from './native.ts';

export function runNativeBuildWorker(
	dependencies: Pick<BuildDependencies, 'sleep'> = {}
): Promise<void> {
	return runNativeBuild(async (environment, signal) => {
		await buildAction(buildPathInputs(environment), environment, {
			...dependencies,
			signal
		});
	});
}
