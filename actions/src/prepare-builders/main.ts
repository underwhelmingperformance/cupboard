import { exportVariable, saveState, setFailed } from '@actions/core';
import { formatErrorWithCauses } from '@cupboard/shared/errors';

import { builderHookStateKey, prepareBuilderHook } from './hook.ts';

async function main(): Promise<void> {
	const hook = await prepareBuilderHook(process.env);
	saveState(builderHookStateKey, hook.directory);
	exportVariable('NIX_CONFIG', hook.nixConfig);
}

void main().catch((error: unknown) => {
	setFailed(formatErrorWithCauses(error));
});
