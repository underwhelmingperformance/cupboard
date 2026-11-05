import { configureConnectionAttempts } from '@cupboard/shared/connection-attempts';
import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { nativeEvaluationMain, runNativeEvaluation } from './native.ts';

configureConnectionAttempts();
initialiseTracing();

void runNativeEvaluation(nativeEvaluationMain);
