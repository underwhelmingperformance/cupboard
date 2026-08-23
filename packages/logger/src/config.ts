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

export const loggerCategory = ['cupboard'] as const;

export interface LoggingOptions {
	/**
	 * The sink that receives log records. If this is omitted, {@link resolveSink}
	 * selects a sink from the environment.
	 */
	readonly sink?: Sink;
	/**
	Defaults to `debug`.
	*/
	readonly lowestLevel?: LogLevel;
}

/**
 * When `GITHUB_ACTIONS=true`, the default sink writes workflow-command syntax
 * to stdout. Other environments receive line-delimited JSON on stderr.
 * Entrypoints that select their own output format pass an explicit sink to
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
 * Configures LogTape once for the current isolate or process. Later calls leave
 * the global configuration unchanged, which lets several entrypoints share an
 * isolate. Callers add request context through `.with(...)` child loggers. Every
 * Cupboard sink is synchronous, so configuration is synchronous too.
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
 * Callers derive request or operation loggers with `.with(fields)` and pass the
 * resulting logger to downstream functions.
 */
export function rootLogger(): Logger {
	return getLogger(loggerCategory);
}
