import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { withActionLogging } from './logging.ts';

initialiseTracing();

void withActionLogging('cupboard.action.diagnostics', process.env, () =>
	Promise.resolve()
);
