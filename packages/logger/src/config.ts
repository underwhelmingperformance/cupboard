import process from 'node:process';

import {
	isGithubActions,
	type WorkflowCommandStreams
} from '@cupboard/shared/github-actions';
import {
	configureSync,
	getConfig,
	getLogger,
	type Logger,
	type LogLevel,
	type Sink
} from '@logtape/logtape';

import { githubActionsSink, jsonLinesSink } from './sinks.ts';

export type { Logger, LogLevel, LogRecord, Sink } from '@logtape/logtape';
export { getLogger } from '@logtape/logtape';

// The root category every cupboard logger descends from; request- and
// operation-scoped loggers extend it with `.with(fields)`.
export const loggerCategory = ['cupboard'] as const;

/** Options for {@link configureLogging}. */
export interface LoggingOptions {
	/**
	 * Where records are written; one of the sinks from `@cupboard/logger/sinks`.
	 * Omit it to have {@link resolveSink} choose from the environment.
	 */
	readonly sink?: Sink;
	/** The lowest level to emit; defaults to `debug`. */
	readonly lowestLevel?: LogLevel;
}

/**
 * The sink for a run with no explicit choice: GitHub Actions workflow commands
 * under a runner, otherwise line-delimited JSON on stderr. An entrypoint that
 * knows its sink (the Worker, the CLI in a chosen output mode) passes one to
 * {@link configureLogging} instead.
 */
export function resolveSink(streams: WorkflowCommandStreams = {}): Sink {
	if (isGithubActions(streams.environment)) {
		return githubActionsSink(streams);
	}

	const stderr = streams.stderr ?? process.stderr;

	return jsonLinesSink((line) => stderr.write(line));
}

/**
 * Configures LogTape once for the current isolate or process. Idempotent: a
 * second call is a no-op, so several entrypoints sharing an isolate cannot
 * clobber one another's configuration. Per-request context is layered on with
 * `.with(...)` children, never by reconfiguring. Uses the synchronous path
 * because every cupboard sink is synchronous.
 */
export function configureLogging(options: LoggingOptions = {}): void {
	if (getConfig() !== null) {
		return;
	}

	configureSync({
		sinks: { cupboard: options.sink ?? resolveSink() },
		loggers: [
			{
				category: [...loggerCategory],
				sinks: ['cupboard'],
				lowestLevel: options.lowestLevel ?? 'debug'
			},
			// LogTape's own diagnostics; surface warnings and errors through the same sink.
			{
				category: ['logtape', 'meta'],
				sinks: ['cupboard'],
				lowestLevel: 'warning'
			}
		]
	});
}

/**
 * The application's root logger. Callers derive request- and operation-scoped
 * loggers from it with `.with(fields)` and pass those down as the first argument.
 */
export function rootLogger(): Logger {
	return getLogger(loggerCategory);
}
