import {
	configureSync,
	type LogLevel,
	resetSync,
	type Sink
} from '@logtape/logtape';

import { loggerCategory } from './config.ts';

export interface CapturedLog {
	readonly level: LogLevel;
	readonly category: readonly string[];
	readonly message: string;
	readonly properties: Record<string, unknown>;
}

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

export interface Capture {
	readonly logs: CapturedLog[];
	stop(): void;
}

/**
 * Resets LogTape and captures Cupboard records until `stop()` resets it again.
 * Tests must call `stop()` during teardown because LogTape configuration is
 * global to the process.
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
