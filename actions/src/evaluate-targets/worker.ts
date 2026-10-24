import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { nativeEvaluationWorker, runNativeEvaluation } from './native.ts';

initialiseTracing();

void runNativeEvaluation(nativeEvaluationWorker);
