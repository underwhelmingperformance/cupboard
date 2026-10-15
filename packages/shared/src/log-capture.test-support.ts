import { configureSync, type LogLevel, resetSync } from '@logtape/logtape';
import { onTestFinished } from 'vitest';

export interface CapturedRecord {
	readonly level: LogLevel;
	readonly category: readonly string[];
	readonly message: string;
	readonly properties: Record<string, unknown>;
}

/**
 * Captures Cupboard log records at every level until the current test
 * finishes. `@cupboard/logger/testing` provides the same capture, but
 * `@cupboard/logger` depends on this package.
 */
export function captureLogs(): CapturedRecord[] {
	const records: CapturedRecord[] = [];

	configureSync({
		reset: true,
		sinks: {
			capture: (record) => {
				records.push({
					level: record.level,
					category: record.category,
					message: record.message.map(String).join(''),
					properties: record.properties
				});
			}
		},
		loggers: [
			{ category: ['cupboard'], sinks: ['capture'], lowestLevel: 'trace' },
			{
				category: ['logtape', 'meta'],
				sinks: ['capture'],
				lowestLevel: 'warning'
			}
		]
	});
	onTestFinished(() => {
		resetSync();
	});

	return records;
}
