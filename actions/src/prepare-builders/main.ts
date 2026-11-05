import { exportVariable, saveState, setFailed } from '@actions/core';
import { configureConnectionAttempts } from '@cupboard/shared/connection-attempts';
import { formatErrorWithCauses } from '@cupboard/shared/errors';
import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { withActionLogging } from '../diagnostics/logging.ts';

import { builderHookStateKey, prepareBuilderHook } from './hook.ts';

async function main(): Promise<void> {
	const hook = await prepareBuilderHook(process.env);
	if (hook === undefined) {
		return;
	}
	saveState(builderHookStateKey, hook.directory);
	exportVariable('NIX_CONFIG', hook.nixConfig);
}

configureConnectionAttempts();
initialiseTracing();

void withActionLogging(
	'cupboard.action.prepare-builders',
	process.env,
	main
).catch((error: unknown) => {
	setFailed(formatErrorWithCauses(error));
});
