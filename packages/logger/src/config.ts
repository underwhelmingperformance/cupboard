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

// The root category for all Cupboard loggers. Request- and operation-scoped
// loggers add fields with `.with(fields)`.
export const loggerCategory = ['cupboard'] as const;

/**
Options for {@link configureLogging}.
*/
export interface LoggingOptions {
	/**
	 * The sink that receives log records. If this is omitted, {@link resolveSink}
	 * selects a sink from the environment.
	 */
	readonly sink?: Sink;
	/**
	The lowest level to emit; defaults to `debug`.
	*/
	readonly lowestLevel?: LogLevel;
}

/**
 * Selects a sink when the caller does not specify one. GitHub Actions receives
 * workflow commands, and other environments receive line-delimited JSON on
 * stderr. Entrypoints that select their own output format pass a sink to
 * {@link configureLogging}.
 */
export function resolveSink(streams: WorkflowCommandStreams = {}): Sink {
	if (isGithubActions(streams.environment)) {
		return githubActionsSink(streams);
	}

	const stderr = streams.stderr ?? process.stderr;

	return jsonLinesSink((line) => stderr.write(line));
}

/**
 * Configures LogTape once for the current isolate or process. Later calls return
 * without changing the existing configuration, which lets several entrypoints
 * share an isolate. Callers add request context through `.with(...)` child
 * loggers. Every Cupboard sink is synchronous, so this function uses LogTape's
 * synchronous configuration API.
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
			{
				category: ['logtape', 'meta'],
				sinks: ['cupboard'],
				lowestLevel: 'warning'
			}
		]
	});
}

/**
 * The application's root logger. Callers add request or operation fields with
 * `.with(fields)`, then pass the resulting logger to downstream functions.
 */
export function rootLogger(): Logger {
	return getLogger(loggerCategory);
}
