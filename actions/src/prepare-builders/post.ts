import { getState, setFailed } from '@actions/core';
import { formatErrorWithCauses } from '@cupboard/shared/errors';

import { builderHookStateKey, removeBuilderHook } from './hook.ts';

async function post(): Promise<void> {
	const directory = getState(builderHookStateKey);
	if (directory !== '') {
		await removeBuilderHook(directory);
	}
}

void post().catch((error: unknown) => {
	setFailed(formatErrorWithCauses(error));
});
