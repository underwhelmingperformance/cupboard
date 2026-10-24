import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { exportVariable, saveState } from '@actions/core';
import { configureLogging, rootLogger, type Sink } from '@cupboard/logger';
import { createFileSink, type FileLogging } from '@cupboard/logger/file';
import {
	httpDiagnosticCounters,
	traceOperation
} from '@cupboard/shared/node-tracing';
import { SpanStatusCode } from '@opentelemetry/api';

import type { Environment } from '../inputs.ts';

export const diagnosticsDirectoryKey = 'CUPBOARD_LOG_DIRECTORY';
export const diagnosticsOwnerState = 'cupboard-diagnostics-owner';

/**
Starts shared file logging before action setup or authentication begins.
*/
export function startActionLogging(
	environment: Environment,
	sink?: Sink
): FileLogging | undefined {
	if (
		environment.GITHUB_ACTIONS !== 'true' &&
		environment[diagnosticsDirectoryKey] === undefined
	) {
		configureLogging({ sink });
		return undefined;
	}

	const directory =
		environment[diagnosticsDirectoryKey] ?? createDirectory(environment);
	const logging = createFileSink(
		path.join(
			directory,
			`process-${String(process.pid)}-${randomUUID()}.jsonl.zst`
		),
		{
			onError: (error) => {
				rootLogger().warn('diagnostic file logging failed', { error });
			}
		}
	);

	configureLogging({ sink, fileSink: logging.sink });
	rootLogger().trace('action process started', {
		processId: process.pid,
		nodeVersion: process.version,
		platform: process.platform,
		architecture: process.arch,
		job: environment.GITHUB_JOB,
		runId: environment.GITHUB_RUN_ID,
		runAttempt: environment.GITHUB_RUN_ATTEMPT,
		runner: environment.RUNNER_NAME
	});

	return logging;
}

function createDirectory(environment: Environment): string {
	const temporary = environment.RUNNER_TEMP;

	if (temporary === undefined || temporary === '') {
		throw new Error('RUNNER_TEMP is required for action diagnostic logging');
	}

	const directory = path.join(
		temporary,
		`cupboard-diagnostics-${randomUUID()}`
	);

	mkdirSync(directory, { recursive: true, mode: 0o700 });
	exportVariable(diagnosticsDirectoryKey, directory);
	saveState(diagnosticsOwnerState, directory);

	return directory;
}

/**
Gives each subprocess a separate file within the shared job directory.
*/
export function subprocessLogFile(
	environment: Environment
): string | undefined {
	const directory =
		environment[diagnosticsDirectoryKey] ??
		process.env[diagnosticsDirectoryKey];

	return directory === undefined
		? undefined
		: path.join(directory, `cli-${randomUUID()}.jsonl.zst`);
}

/**
Finalises process logs on both success and failure within the action's trace.
*/
export async function withActionLogging<T>(
	operation: string,
	environment: Environment,
	run: () => Promise<T>,
	sink?: Sink
): Promise<T> {
	return traceOperation(operation, async (span) => {
		const started = performance.now();
		let logging: FileLogging | undefined;
		let exitCode = 1;

		try {
			logging = startActionLogging(environment, sink);
		} catch (error) {
			configureLogging({ sink });
			rootLogger().warn('could not initialise diagnostic file logging', {
				error
			});
		}

		try {
			const result = await run();
			exitCode =
				typeof result === 'number' ? result : Number(process.exitCode ?? 0);
			span.setAttribute('process.exit.code', exitCode);

			if (exitCode !== 0) {
				span.setStatus({ code: SpanStatusCode.ERROR });
			}

			return result;
		} catch (error) {
			rootLogger().debug('action process failed', { operation, error });
			throw error;
		} finally {
			rootLogger().trace('action process completed', {
				operation,
				elapsedMs: performance.now() - started,
				exitCode,
				http: httpDiagnosticCounters()
			});

			await logging?.close();
		}
	});
}
