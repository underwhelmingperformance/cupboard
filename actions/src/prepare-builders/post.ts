import { getState, setFailed } from '@actions/core';
import { formatErrorWithCauses } from '@cupboard/shared/errors';
import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { withActionLogging } from '../diagnostics/logging.ts';
import { uploadDiagnostics } from '../diagnostics/upload.ts';

import { builderHookStateKey, removeBuilderHook } from './hook.ts';

async function post(): Promise<void> {
	const directory = getState(builderHookStateKey);
	if (directory !== '') {
		await removeBuilderHook(directory);
	}
}

initialiseTracing();

async function finalise(): Promise<void> {
	try {
		await withActionLogging(
			'cupboard.action.prepare-builders.post',
			process.env,
			post
		);
	} finally {
		await uploadDiagnostics();
	}
}

void finalise().catch((error: unknown) => {
	setFailed(formatErrorWithCauses(error));
});
