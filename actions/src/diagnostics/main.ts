import { configureConnectionAttempts } from '@cupboard/shared/connection-attempts';
import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { withActionLogging } from './logging.ts';

configureConnectionAttempts();
initialiseTracing();

void withActionLogging('cupboard.action.diagnostics', process.env, () =>
	Promise.resolve()
);
