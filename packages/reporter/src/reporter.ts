import { appendFileSync } from 'node:fs';
import { stderr, stdout } from 'node:process';

import { errorCauses, formatErrorWithCauses } from '@cupboard/shared/errors';
import { workflowCommands } from '@cupboard/shared/github-actions';
import { z } from 'zod';

const reportedErrors = new WeakSet<object>();

/**
 * Records an error object's identity globally so another reporter can suppress
 * a duplicate diagnostic. Primitive thrown values cannot be tracked.
 */
export function markErrorReported(error: unknown): void {
	if (typeof error === 'object' && error !== null) {
		reportedErrors.add(error);
	}
}

export function wasErrorReported(error: unknown): boolean {
	return (
		typeof error === 'object' && error !== null && reportedErrors.has(error)
	);
}

export interface PhaseContext {
	fact(label: string, value: string | number): void;
	/**
	 * Reports a warning for this unit. JSON and GitHub modes emit it immediately.
	 * Terminal spinners and progress bars defer it until the animation ends; a
	 * task log shows it live and repeats it after the task closes.
	 */
	warn(label: string, value?: string): void;
}

export interface ProgressHandle {
	/**
	Advance the bar by `step` units (default 1), optionally retitling it.
	*/
	advance(step?: number, message?: string): void;
	/**
	Adds or replaces a live key/value annotation.
	*/
	fact(label: string, value: string | number): void;
	/**
	Records a warning for this unit; see {@link PhaseContext.warn}.
	*/
	warn(label: string, value?: string): void;
}

export interface ProgressOptions {
	readonly total: number;
}

export interface StepGroup {
	message(message: string): void;
	success(message: string): void;
	error(message: string): void;
}

export interface StepLog {
	message(message: string): void;
	group(name: string): StepGroup;
	/**
	Records a warning for this task; see {@link PhaseContext.warn}.
	*/
	warn(label: string, value?: string): void;
}

export interface ResultRow {
	readonly label: string;
	readonly value: string;
}

/**
 * `kind` and `data` are the stable machine result. JSON mode emits them as a
 * result event, and every mode appends them to `resultFile` when configured.
 * Terminal mode renders `rows` as a card; GitHub mode writes them as plain
 * `label: value` lines. Rows and `empty` are display-only.
 */
export interface ResultPayload<T = unknown> {
	readonly kind: string;
	readonly data: T;
	readonly rows: readonly ResultRow[];
	/**
	 * Terminal and GitHub modes render this text when `rows` is empty. JSON mode
	 * still emits the empty `data` value.
	 */
	readonly empty?: string;
}

export interface Reporter {
	phase<T>(
		label: string,
		body: (context: PhaseContext) => Promise<T> | T
	): Promise<T>;
	progress<T>(
		label: string,
		options: ProgressOptions,
		body: (bar: ProgressHandle) => Promise<T> | T
	): Promise<T>;
	steps<T>(label: string, body: (log: StepLog) => Promise<T> | T): Promise<T>;
	result(payload: ResultPayload): void;
	/**
	 * Writes a raw payload followed by a newline to `out`. JSON mode keeps `out`
	 * separate from its event stream. GitHub mode writes all rendering to `out`.
	 * The terminal adapter uses `out` for data while Clack writes its UI directly.
	 */
	data(text: string): void;
	warn(label: string, value?: string): void;
	info(message: string): void;
	/**
	 * Reports completed work as a terminal success marker, a JSON `success` event,
	 * or a GitHub notice when workflow commands are active.
	 */
	success(message: string): void;
	/**
	 * Reports skipped work as a terminal step marker, a JSON `step` event, or a
	 * plain GitHub log line.
	 */
	step(message: string): void;
	/**
	 * Reports a failure with its cause chain. Terminal mode renders an indented
	 * error, JSON mode emits an `error` event, and GitHub mode uses an annotation
	 * when workflow commands are active.
	 */
	error(error: unknown): void;
}

export type ReporterMode = 'terminal' | 'json' | 'github';

/**
 * Build-push emits these phase labels in run order. The labels remain stable
 * because JSON consumers use them to identify phase events.
 */
export const buildPushPhases = {
	build: 'Building',
	queue: 'Queueing completed paths',
	upload: 'Uploading missing NARs',
	reconcile: 'Reconciling build results',
	retention: 'Recording retention'
} as const;

export type BuildPushPhase = keyof typeof buildPushPhases;

export interface ReporterOptions {
	/**
	 * Destination for JSON events. {@link createReporter} defaults it to stderr;
	 * terminal and GitHub reporters do not use it.
	 */
	readonly stream?: NodeJS.WritableStream;
	/**
	 * Destination for JSON and terminal `data` payloads, and for all GitHub
	 * rendering. Defaults to stdout.
	 */
	readonly out?: NodeJS.WritableStream;
	/**
	The clock used for durations and progress throttling; defaults to `Date.now`.
	*/
	readonly now?: () => number;
	/**
	 * A path to which every mode appends one JSONL event for each
	 * {@link Reporter.result}. Read it with {@link parseReporterResults}.
	 */
	readonly resultFile?: string;
}

export const reporterResultEventSchema = z.strictObject({
	kind: z.string(),
	data: z.unknown()
});

export type ReporterResultEvent = z.infer<typeof reporterResultEventSchema>;

export class MalformedResultLineError extends Error {
	constructor(readonly line: string) {
		super('reporter result line is not a valid result event');
		this.name = 'MalformedResultLineError';
	}
}

/**
 * Parses a `--result-file`'s contents into its result events, skipping blank
 * lines. Throws a {@link MalformedResultLineError} on the first line that is not
 * a JSON result event, so a corrupt file fails loudly rather than dropping data.
 */
export function parseReporterResults(
	fileContents: string
): ReporterResultEvent[] {
	const events: ReporterResultEvent[] = [];

	for (const line of fileContents.split('\n')) {
		const trimmed = line.trim();

		if (trimmed === '') {
			continue;
		}

		const parsed = parseResultLine(trimmed);

		if (parsed === undefined) {
			throw new MalformedResultLineError(trimmed);
		}

		events.push(parsed);
	}

	return events;
}

function parseResultLine(line: string): ReporterResultEvent | undefined {
	let value: unknown;

	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}

	const result = reporterResultEventSchema.safeParse(value);

	return result.success ? result.data : undefined;
}

/**
 * Appends one result event to the JSONL result file. A reporter in any mode
 * calls this for every {@link Reporter.result} when a `resultFile` is set, so a
 * caller can read a run's results back with {@link parseReporterResults}.
 */
export function appendResultEvent(
	resultFile: string,
	payload: ResultPayload
): void {
	appendFileSync(
		resultFile,
		`${JSON.stringify({ kind: payload.kind, data: payload.data })}\n`
	);
}

function resultAppender(resultFile?: string): (payload: ResultPayload) => void {
	if (resultFile === undefined) {
		return () => {
			// Intentionally empty result appender.
		};
	}

	return (payload) => {
		appendResultEvent(resultFile, payload);
	};
}

function warnText(label: string, value?: string): string {
	return value === undefined ? label : `${label}: ${value}`;
}

// Emit at most one interim update per interval. This keeps long operations
// visible without producing one event or line for every unit of work.
const progressIntervalMs = 2000;

/**
 * Emits the machine-readable contract as line-delimited JSON to `stream` and
 * writes raw data to `out`. The defaults are stderr and stdout respectively.
 */
export function createReporter(options: ReporterOptions = {}): Reporter {
	return createJsonReporter(
		options.stream ?? stderr,
		options.out ?? stdout,
		options.now ?? (() => Date.now()),
		resultAppender(options.resultFile)
	);
}

/**
 * Writes all output to `out`, which defaults to stdout. When
 * `GITHUB_ACTIONS=true`, phases and tasks use workflow groups and warnings,
 * successes and failures use command annotations. Otherwise the shared command
 * emitter degrades them to plain lines. Results use `label: value` lines in
 * either environment.
 */
export function createGithubReporter(options: ReporterOptions = {}): Reporter {
	return buildGithubReporter(
		options.out ?? stdout,
		options.now ?? (() => Date.now()),
		resultAppender(options.resultFile)
	);
}

interface StepGroupRecord {
	readonly name: string;
	status: 'ok' | 'failed' | 'open';
	readonly messages: string[];
}

function createJsonReporter(
	stream: NodeJS.WritableStream,
	out: NodeJS.WritableStream,
	now: () => number,
	recordResult: (payload: ResultPayload) => void
): Reporter {
	function emit(event: Record<string, unknown>): void {
		stream.write(`${JSON.stringify(event)}\n`);
	}

	function emitWarn(label: string, value?: string): void {
		emit(
			value === undefined
				? { event: 'warn', label }
				: { event: 'warn', label, value }
		);
	}

	return {
		async phase(label, body) {
			const facts: Record<string, string> = {};
			const startedAt = now();
			// Start the interval clock with the phase, so short phases emit only the
			// final event.
			let lastEmitAt = startedAt;

			try {
				const value = await body({
					fact(factLabel, factValue) {
						facts[factLabel] = String(factValue);

						const at = now();

						if (at - lastEmitAt < progressIntervalMs) {
							return;
						}

						lastEmitAt = at;
						emit({
							event: 'progress',
							label,
							durationMs: at - startedAt,
							facts
						});
					},
					warn: emitWarn
				});

				emit({
					event: 'phase',
					label,
					status: 'ok',
					durationMs: now() - startedAt,
					facts
				});

				return value;
			} catch (error) {
				emit({
					event: 'phase',
					label,
					status: 'failed',
					durationMs: now() - startedAt,
					error: error instanceof Error ? error.message : String(error)
				});

				throw error;
			}
		},

		async progress(label, options, body) {
			const facts: Record<string, string> = {};
			const startedAt = now();
			let completed = 0;
			// Start the interval clock with the phase, so short phases emit only the
			// final event.
			let lastEmitAt = startedAt;

			const finish = (status: 'ok' | 'failed', extra: object): void => {
				emit({
					event: 'phase',
					label,
					status,
					durationMs: now() - startedAt,
					total: options.total,
					completed,
					facts,
					...extra
				});
			};

			try {
				const value = await body({
					advance(step = 1) {
						completed += step;

						const at = now();

						if (at - lastEmitAt < progressIntervalMs) {
							return;
						}

						lastEmitAt = at;
						emit({
							event: 'progress',
							label,
							durationMs: at - startedAt,
							total: options.total,
							completed,
							facts
						});
					},
					fact(factLabel, factValue) {
						facts[factLabel] = String(factValue);
					},
					warn: emitWarn
				});

				finish('ok', {});

				return value;
			} catch (error) {
				finish('failed', {
					error: error instanceof Error ? error.message : String(error)
				});

				throw error;
			}
		},

		async steps(label, body) {
			const groups: StepGroupRecord[] = [];
			const startedAt = now();

			const addGroup = (name: string): StepGroup => {
				const record: StepGroupRecord = { name, status: 'open', messages: [] };
				groups.push(record);

				return {
					message(message) {
						record.messages.push(message);
					},
					success(message) {
						record.messages.push(message);
						record.status = 'ok';
					},
					error(message) {
						record.messages.push(message);
						record.status = 'failed';
					}
				};
			};

			const messages: string[] = [];

			try {
				const value = await body({
					message(message) {
						messages.push(message);
					},
					group: addGroup,
					warn: emitWarn
				});

				emit({
					event: 'phase',
					label,
					status: 'ok',
					durationMs: now() - startedAt,
					groups,
					...(messages.length > 0 && { messages })
				});

				return value;
			} catch (error) {
				emit({
					event: 'phase',
					label,
					status: 'failed',
					durationMs: now() - startedAt,
					groups,
					...(messages.length > 0 && { messages }),
					error: error instanceof Error ? error.message : String(error)
				});

				throw error;
			}
		},

		result(payload) {
			emit({ event: 'result', kind: payload.kind, data: payload.data });
			recordResult(payload);
		},

		data(text) {
			out.write(`${text}\n`);
		},

		warn: emitWarn,

		info(message) {
			emit({ event: 'info', message });
		},

		success(message) {
			emit({ event: 'success', message });
		},

		step(message) {
			emit({ event: 'step', message });
		},

		error(error) {
			emit({ event: 'error', ...describeError(error) });
		}
	};
}

function describeError(error: unknown): {
	name: string;
	message: string;
	causes?: string[];
} {
	const causes = errorCauses(error);

	return {
		name: error instanceof Error ? error.name : 'Error',
		message: error instanceof Error ? error.message : String(error),
		...(causes.length > 0 && { causes })
	};
}

function buildGithubReporter(
	out: NodeJS.WritableStream,
	now: () => number,
	recordResult: (payload: ResultPayload) => void
): Reporter {
	const commands = workflowCommands({ stdout: out, stderr: out });
	const line = (text: string): void => {
		out.write(`${text}\n`);
	};

	const emitWarn = (label: string, value?: string): void => {
		commands.warning(warnText(label, value));
	};

	const emitFacts = (facts: ReadonlyMap<string, string>): void => {
		for (const [label, value] of facts) {
			line(`${label}: ${value}`);
		}
	};

	const addGroup = (name: string): StepGroup => {
		line(`${name}:`);

		return {
			message: (message) => {
				line(`  ${message}`);
			},
			success: (message) => {
				line(`  ${message}`);
			},
			error: (message) => {
				line(`  ${message}`);
			}
		};
	};
	const emitError = (error: unknown): void => {
		if (wasErrorReported(error)) {
			return;
		}

		// With `GITHUB_ACTIONS=true`, the command emitter escapes newlines so the
		// complete cause chain remains in one annotation.
		commands.error(formatErrorWithCauses(error));
		markErrorReported(error);
	};

	return {
		async phase(label, body) {
			commands.group(label);

			const facts = new Map<string, string>();

			try {
				const value = await body({
					fact(factLabel, factValue) {
						facts.set(factLabel, String(factValue));
					},
					warn: emitWarn
				});

				emitFacts(facts);
				commands.endGroup();

				return value;
			} catch (error) {
				emitFacts(facts);
				emitError(error);
				commands.endGroup();

				throw error;
			}
		},

		async progress(label, options, body) {
			commands.group(label);

			const facts = new Map<string, string>();
			const startedAt = now();
			// Start the interval clock with the phase, so short phases emit only the
			// final line.
			let lastEmitAt = startedAt;
			let completed = 0;

			const summary = (): string =>
				`${label}: ${String(completed)}/${String(options.total)}`;

			try {
				const value = await body({
					advance(step = 1) {
						completed += step;

						const at = now();

						if (at - lastEmitAt < progressIntervalMs) {
							return;
						}

						lastEmitAt = at;
						line(summary());
					},
					fact(factLabel, factValue) {
						facts.set(factLabel, String(factValue));
					},
					warn: emitWarn
				});

				emitFacts(facts);
				line(summary());
				commands.endGroup();

				return value;
			} catch (error) {
				emitFacts(facts);
				emitError(error);
				commands.endGroup();

				throw error;
			}
		},

		async steps(label, body) {
			commands.group(label);

			try {
				const value = await body({
					message: (message) => {
						line(message);
					},
					group: addGroup,
					warn: emitWarn
				});

				commands.endGroup();

				return value;
			} catch (error) {
				emitError(error);
				commands.endGroup();

				throw error;
			}
		},

		result(payload) {
			if (payload.rows.length === 0) {
				if (payload.empty !== undefined) {
					line(payload.empty);
				}
			} else {
				for (const row of payload.rows) {
					line(`${row.label}: ${row.value}`);
				}
			}

			recordResult(payload);
		},

		data(text) {
			line(text);
		},

		warn: emitWarn,

		info(message) {
			line(message);
		},

		success(message) {
			commands.notice(message);
		},

		step(message) {
			line(message);
		},

		error(error) {
			emitError(error);
		}
	};
}

export function formatDuration(milliseconds: number): string {
	if (milliseconds < 1000) {
		return `${String(milliseconds)}ms`;
	}

	const seconds = milliseconds / 1000;

	if (seconds < 60) {
		return `${seconds.toFixed(1)}s`;
	}

	const minutes = Math.floor(seconds / 60);
	const remainder = (seconds - minutes * 60).toFixed(1);

	return `${String(minutes)}m ${remainder}s`;
}

export function formatCount(count: number): string {
	return count.toLocaleString('en-GB');
}

/**
 * Renders an ISO 8601 timestamp as a compact `YYYY-MM-DD HH:mm UTC` for terminal
 * display, dropping the seconds and milliseconds. The result is in UTC so it does
 * not depend on the machine's timezone. A value that does not parse is returned
 * unchanged.
 */
export function formatTimestamp(value: string): string {
	const date = new Date(value);

	if (Number.isNaN(date.getTime())) {
		return value;
	}

	const pad = (part: number): string => String(part).padStart(2, '0');
	const day = `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
	const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;

	return `${day} ${time} UTC`;
}

export { default as formatBytes } from 'pretty-bytes';
