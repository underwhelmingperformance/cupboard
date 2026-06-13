#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning
import { createCliUi } from '@cupboard/cli-ui';

import {
	buildProgram,
	cliExitCode,
	failureReporterMode,
	reportCliFailure
} from './cli.ts';
import { translateRpcError } from './client/rpc-errors.ts';
import { CliAbortError } from './errors.ts';

const controller = new AbortController();
let abortExitCode = 130;

function abort(exitCode: number): void {
	abortExitCode = exitCode;
	controller.abort(new CliAbortError());
}

const abortSigint = (): void => {
	abort(130);
};
const abortSigterm = (): void => {
	abort(143);
};

process.once('SIGINT', abortSigint);
process.once('SIGTERM', abortSigterm);

const program = buildProgram({ signal: controller.signal });

try {
	await program.parseAsync();
} catch (error: unknown) {
	const failure = translateRpcError(error);
	const reporter = createCliUi({
		mode: failureReporterMode(program)
	}).reporter();

	reportCliFailure(reporter, failure);
	process.exit(cliExitCode(failure, abortExitCode));
} finally {
	process.removeListener('SIGINT', abortSigint);
	process.removeListener('SIGTERM', abortSigterm);
}
