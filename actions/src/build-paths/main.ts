import { configureConnectionAttempts } from '@cupboard/shared/connection-attempts';
import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { nativeBuildMain, runNativeBuild } from './native.ts';

configureConnectionAttempts();
initialiseTracing();

void runNativeBuild(nativeBuildMain);
