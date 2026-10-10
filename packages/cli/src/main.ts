#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning
import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { configureCompressionThreadPool } from './push/thread-pool.ts';
import { runCli } from './run.ts';

configureCompressionThreadPool();
initialiseTracing();

const exitCode = await runCli();

if (exitCode !== 0) {
	process.exit(exitCode);
}
