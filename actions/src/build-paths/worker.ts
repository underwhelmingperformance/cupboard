import { buildAction } from '../commands/build.ts';

import { buildPathInputs, runNativeBuild } from './native.ts';

void runNativeBuild(async (environment, signal) => {
	await buildAction(buildPathInputs(environment), environment, { signal });
});
