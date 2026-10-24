import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { nativeBuildMain, runNativeBuild } from './native.ts';

initialiseTracing();

void runNativeBuild(nativeBuildMain);
