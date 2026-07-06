import {
	configureSync,
	type LogLevel,
	resetSync,
	type Sink
} from '@logtape/logtape';

import { loggerCategory } from './config.ts';

/** One captured record, its fields fully merged from the parent `.with()` calls. */
export interface CapturedLog {
	readonly level: LogLevel;
	readonly category: readonly string[];
	readonly message: string;
	readonly properties: Record<string, unknown>;
}

/** A sink that appends every record to `into` for assertions. */
export function capturingSink(into: CapturedLog[]): Sink {
	return (record) => {
		into.push({
			level: record.level,
			category: record.category,
			message: record.message
				.map((part) => (typeof part === 'string' ? part : String(part)))
				.join(''),
			properties: record.properties
		});
	};
}

/** A running capture: `logs` accumulates records until `stop()` tears it down. */
export interface Capture {
	readonly logs: CapturedLog[];
	stop(): void;
}

/**
 * Configures LogTape (resetting any prior configuration) to capture cupboard
 * logs into an array, for tests. Call `stop()` in teardown to reset. Every
 * cupboard sink is synchronous, so the sync configuration path is used.
 */
export function startCapture(): Capture {
	const logs: CapturedLog[] = [];

	configureSync({
		reset: true,
		sinks: { capture: capturingSink(logs) },
		loggers: [
			{
				category: [...loggerCategory],
				sinks: ['capture'],
				lowestLevel: 'trace'
			},
			// Route LogTape's own diagnostics through the capture sink too, so a
			// misconfiguration surfaces in tests.
			{
				category: ['logtape', 'meta'],
				sinks: ['capture'],
				lowestLevel: 'warning'
			}
		]
	});

	return {
		logs,
		stop: () => {
			resetSync();
		}
	};
}
