#!/usr/bin/env -S node --experimental-transform-types --disable-warning=ExperimentalWarning
import { isAbortError } from './abort.ts';
import { buildProgram } from './cli.ts';
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

try {
	await buildProgram({ signal: controller.signal }).parseAsync();
} catch (error: unknown) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`
	);
	process.exit(isAbortError(error) ? abortExitCode : 1);
} finally {
	process.removeListener('SIGINT', abortSigint);
	process.removeListener('SIGTERM', abortSigterm);
}
