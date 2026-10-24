import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { runNativeBuildWorker } from './native-worker.ts';

initialiseTracing();

void runNativeBuildWorker();
