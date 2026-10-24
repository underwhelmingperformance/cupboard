import { AsyncLocalStorage } from 'node:async_hooks';
import process from 'node:process';

import {
	isGithubActions,
	type WorkflowCommandStreams
} from '@cupboard/shared/github-actions';
import { traceLogFields } from '@cupboard/shared/log-context';
import {
	configureSync,
	getConfig,
	getLogger,
	type Logger,
	type LogLevel,
	type Sink,
	withFilter
} from '@logtape/logtape';

import { redactingSink } from './redaction.ts';
import { serialiseLogProperties } from './serialisation.ts';
import { githubActionsSink, jsonLinesSink } from './sinks.ts';

export type { Logger, LogLevel, LogRecord, Sink } from '@logtape/logtape';
export { getLogger, withContext } from '@logtape/logtape';

export const loggerCategory = ['cupboard'] as const;

export interface LoggingOptions {
	readonly fileSink?: Sink;
	/**
	The sink that receives log records. If this is omitted, {@link resolveSink}
	selects a sink from the environment.
	*/
	readonly sink?: Sink;
	/**
	Defaults to `debug`.
	*/
	readonly lowestLevel?: LogLevel;
}

function observedSink(sink: Sink): Sink {
	const redacted = redactingSink(sink);

	return (record) => {
		redacted({
			...record,
			properties: {
				...serialiseLogProperties(record.properties),
				...traceLogFields()
			}
		});
	};
}

/**
When `GITHUB_ACTIONS=true`, the default sink writes workflow-command syntax
to stdout. Other environments receive line-delimited JSON on stderr.
Entrypoints that select their own output format pass an explicit sink to
{@link configureLogging}.
*/
export function resolveSink(streams: WorkflowCommandStreams = {}): Sink {
	if (isGithubActions(streams.environment)) {
		return githubActionsSink(streams);
	}

	const stderr = streams.stderr ?? process.stderr;

	return jsonLinesSink((line) => stderr.write(line));
}

/**
Configures LogTape once for the current isolate or process. Later calls leave
the global configuration unchanged, which lets several entrypoints share an
isolate. Callers add request context through `.with(...)` child loggers. Every
Cupboard sink is synchronous, so configuration is synchronous too.
*/
export function configureLogging(options: LoggingOptions = {}): void {
	if (getConfig() !== null) {
		return;
	}

	const destination = options.sink ?? resolveSink();
	const consoleSink = withFilter(
		observedSink(destination),
		options.lowestLevel ?? 'debug'
	);
	const metaConsoleSink = withFilter(observedSink(destination), 'warning');
	const sinks: Record<string, Sink> = {
		cupboard: consoleSink,
		meta: metaConsoleSink
	};
	const sinkIds = ['cupboard'];
	const metaSinkIds = ['meta'];

	if (options.fileSink !== undefined) {
		sinks.file = observedSink(options.fileSink);
		sinkIds.push('file');
		metaSinkIds.push('file');
	}

	configureSync({
		contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
		sinks,
		loggers: [
			{
				category: [...loggerCategory],
				sinks: sinkIds,
				lowestLevel:
					options.fileSink === undefined
						? (options.lowestLevel ?? 'debug')
						: 'trace'
			},
			{
				category: ['logtape', 'meta'],
				sinks: metaSinkIds,
				lowestLevel: options.fileSink === undefined ? 'warning' : 'trace'
			}
		]
	});
}

/**
Callers derive request or operation loggers with `.with(fields)` and pass the
resulting logger to downstream functions.
*/
export function rootLogger(): Logger {
	return getLogger(loggerCategory);
}
