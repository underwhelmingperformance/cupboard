import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { nativeEvaluationMain, runNativeEvaluation } from './native.ts';

initialiseTracing();

void runNativeEvaluation(nativeEvaluationMain);
