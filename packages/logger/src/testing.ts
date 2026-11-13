import { AsyncLocalStorage } from 'node:async_hooks';

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

export function capturingSink(
	into: CapturedLog[],
	onCapture?: (entry: CapturedLog) => void
): Sink {
	return (record) => {
		const entry: CapturedLog = {
			level: record.level,
			category: record.category,
			message: record.message
				.map((part) => (typeof part === 'string' ? part : String(part)))
				.join(''),
			properties: record.properties
		};

		into.push(entry);
		onCapture?.(entry);
	};
}

const warningLevels: ReadonlySet<LogLevel> = new Set<LogLevel>([
	'warning',
	'error',
	'fatal'
]);

/**
Returns the captured records at warning level or above. A test that asserts
on this list fails when a path logs an unexpected error, and ignores the
info and debug records that background work can log at the same time.
*/
export function atWarningOrAbove(logs: readonly CapturedLog[]): CapturedLog[] {
	return logs.filter((entry) => warningLevels.has(entry.level));
}

/**
Rejects the promise of `Capture.until` when the capture stops before a
matching record is logged.
*/
export class CaptureStoppedError extends Error {
	constructor() {
		super('The log capture stopped before a matching record was logged');
		this.name = 'CaptureStoppedError';
	}
}

export interface Capture {
	readonly logs: CapturedLog[];
	/**
	Returns a promise for the first record that satisfies `isMatch`. The
	promise resolves at once with a record that was captured already, and
	otherwise when the sink receives a matching record. It rejects with a
	`CaptureStoppedError` when the capture stops first.
	*/
	until(isMatch: (entry: CapturedLog) => boolean): Promise<CapturedLog>;
	stop(): void;
}

function ignoreRejection(): void {
	return;
}

interface LogWaiter {
	readonly isMatch: (entry: CapturedLog) => boolean;
	readonly resolve: (entry: CapturedLog) => void;
	readonly reject: (error: CaptureStoppedError) => void;
}

/**
Resets LogTape and captures Cupboard records until `stop()` resets it again.
Tests must call `stop()` during teardown because LogTape configuration is
global to the process.
*/
export function startCapture(): Capture {
	const logs: CapturedLog[] = [];
	let waiters: LogWaiter[] = [];
	let isStopped = false;

	configureSync({
		reset: true,
		contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
		sinks: {
			capture: capturingSink(logs, (entry) => {
				const unmatched: LogWaiter[] = [];

				for (const waiter of waiters) {
					if (waiter.isMatch(entry)) {
						waiter.resolve(entry);
					} else {
						unmatched.push(waiter);
					}
				}

				waiters = unmatched;
			})
		},
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
		until: (isMatch) => {
			const captured = logs.find((entry) => isMatch(entry));

			if (captured !== undefined) {
				return Promise.resolve(captured);
			}

			const { promise, resolve, reject } = Promise.withResolvers<CapturedLog>();

			// A test that fails before it awaits the promise would otherwise report
			// an unhandled rejection when the capture stops. A caller that awaits the
			// promise still receives the rejection.
			void promise.catch(ignoreRejection);

			if (isStopped) {
				reject(new CaptureStoppedError());
			} else {
				waiters.push({ isMatch, resolve, reject });
			}

			return promise;
		},
		stop: () => {
			isStopped = true;
			resetSync();

			const unmatched = waiters;
			waiters = [];

			for (const waiter of unmatched) {
				waiter.reject(new CaptureStoppedError());
			}
		}
	};
}

/**
Removes the LogTape configuration. Records are dropped until something
configures logging again.
*/
export function stopLogging(): void {
	resetSync();
}
