import { configureClackUi, createCliUi } from '@cupboard/cli-ui';

import {
	buildProgram,
	cliExitCode,
	failureColour,
	failureReporterMode,
	reportCliFailure
} from './cli.ts';
import { translateRpcError } from './client/rpc-errors.ts';
import { CliAbortError } from './errors.ts';

/**
 * Parse `argv` and run the matching command, returning the process exit code.
 * Both the ESM entry point and the bundled single-executable entry call this,
 * sharing one funnel for interrupts, usage errors and reporting. `argv` defaults
 * to `process.argv`; pass an explicit list (including the node and program
 * placeholders) to drive it from a test.
 */
export async function runCli(argv?: readonly string[]): Promise<number> {
	const controller = new AbortController();
	const abortState = { exitCode: 130 };

	const abortSigint = (): void => {
		abortState.exitCode = 130;
		controller.abort(new CliAbortError());
	};
	const abortSigterm = (): void => {
		abortState.exitCode = 143;
		controller.abort(new CliAbortError());
	};

	process.once('SIGINT', abortSigint);
	process.once('SIGTERM', abortSigterm);

	configureClackUi();

	const program = buildProgram({ signal: controller.signal });

	try {
		await program.parseAsync(argv === undefined ? undefined : [...argv]);
		return 0;
	} catch (error: unknown) {
		const failure = translateRpcError(error);
		const reporter = createCliUi({
			mode: failureReporterMode(program),
			colour: failureColour(program)
		}).reporter();

		reportCliFailure(reporter, failure);
		return cliExitCode(failure, abortState.exitCode);
	} finally {
		process.removeListener('SIGINT', abortSigint);
		process.removeListener('SIGTERM', abortSigterm);
	}
}
