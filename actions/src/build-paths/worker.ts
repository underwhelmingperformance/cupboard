import { configureConnectionAttempts } from '@cupboard/shared/connection-attempts';
import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { runNativeBuildWorker } from './native-worker.ts';

configureConnectionAttempts();
initialiseTracing();

void runNativeBuildWorker();
