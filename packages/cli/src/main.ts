#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning
import { configureCompressionThreadPool } from './push/thread-pool.ts';
import { runCli } from './run.ts';

configureCompressionThreadPool();

const exitCode = await runCli();

if (exitCode !== 0) {
	process.exit(exitCode);
}
