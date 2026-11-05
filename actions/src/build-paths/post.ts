import { configureConnectionAttempts } from '@cupboard/shared/connection-attempts';
import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { uploadDiagnostics } from '../diagnostics/upload.ts';

import { nativeBuildPost, runNativeBuild } from './native.ts';

configureConnectionAttempts();
initialiseTracing();

async function post(): Promise<void> {
	await runNativeBuild(nativeBuildPost);
	await uploadDiagnostics();
}

void post();
