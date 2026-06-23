#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning
import { runCli } from './run.ts';

const exitCode = await runCli();

if (exitCode !== 0) {
	process.exit(exitCode);
}
