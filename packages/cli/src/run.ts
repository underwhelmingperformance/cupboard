import { configureClackUi, createCliUi } from '@cupboard/cli-ui';
import { rootLogger } from '@cupboard/logger';
import type { FileLogging } from '@cupboard/logger/file';
import { markErrorReported, wasErrorReported } from '@cupboard/reporter';
import {
	httpDiagnosticCounters,
	traceOperation
} from '@cupboard/shared/node-tracing';
import { SpanStatusCode } from '@opentelemetry/api';

import {
	buildProgram,
	cliExitCode,
	failureColour,
	failureReporterMode,
	humanErrorFormatter,
	presentationFromGlobals,
	reportCliFailure
} from './cli.ts';
import { translateRpcError } from './client/rpc-errors.ts';
import { CliAbortError } from './errors.ts';
import { cupboardVersion } from './version.ts';

/**
Parse `argv` and run the matching command, returning the process exit code.
Both the ESM entry point and the bundled single-executable entry call this,
sharing one funnel for interrupts, usage errors and reporting. `argv` defaults
to `process.argv`; pass an explicit list (including the node and program
placeholders) to drive it from a test.
*/
export async function runCli(argv?: readonly string[]): Promise<number> {
	return traceOperation('cupboard.command', async (span) => {
		const exitCode = await executeCli(argv);
		span.setAttribute('process.exit.code', exitCode);

		if (exitCode !== 0) {
			span.setStatus({ code: SpanStatusCode.ERROR });
		}

		return exitCode;
	});
}

async function executeCli(
	argv: readonly string[] | undefined
): Promise<number> {
	const controller = new AbortController();
	const abortState = { exitCode: 130 };
	const started = performance.now();
	const runtime = {
		version: cupboardVersion,
		nodeVersion: process.version,
		platform: process.platform,
		architecture: process.arch,
		processId: process.pid
	};
	let logging: FileLogging | undefined;
	let exitCode = 0;

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

	const program = buildProgram({
		signal: controller.signal,
		onFileLogging: (file) => {
			logging = file;
		}
	});
	program.hook('preAction', () => {
		rootLogger().info('command started', runtime);
	});

	try {
		await program.parseAsync(argv === undefined ? undefined : [...argv]);
		return 0;
	} catch (error: unknown) {
		rootLogger().debug('command failed', { error });
		const failure = translateRpcError(error);

		if (wasErrorReported(error)) {
			markErrorReported(failure);
		}

		const reporter = createCliUi({
			mode: failureReporterMode(program),
			presentation: presentationFromGlobals(program),
			formatError: humanErrorFormatter(program),
			colour: failureColour(program)
		}).reporter();

		reportCliFailure(reporter, failure);
		exitCode = cliExitCode(failure, abortState.exitCode);

		return exitCode;
	} finally {
		process.removeListener('SIGINT', abortSigint);
		process.removeListener('SIGTERM', abortSigterm);
		rootLogger().info('command completed', {
			...runtime,
			elapsedMs: performance.now() - started,
			exitCode,
			http: httpDiagnosticCounters()
		});
		await logging?.close();
	}
}
