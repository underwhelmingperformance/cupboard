import { appendFileSync } from 'node:fs';
import { stderr, stdout } from 'node:process';

import { errorCauses, formatErrorWithCauses } from '@cupboard/shared/errors';
import { workflowCommands } from '@cupboard/shared/github-actions';
import { z } from 'zod';

const reportedErrors = new WeakSet<object>();

/** Records that a diagnostic for an error has already been emitted. */
export function markErrorReported(error: unknown): void {
	if (typeof error === 'object' && error !== null) {
		reportedErrors.add(error);
	}
}

/** Whether a reporter has already emitted a diagnostic for an error. */
export function wasErrorReported(error: unknown): boolean {
	return (
		typeof error === 'object' && error !== null && reportedErrors.has(error)
	);
}

export interface PhaseContext {
	fact(label: string, value: string | number): void;
	/**
	 * Raise a durable warning that belongs to this unit of work. It is shown as
	 * soon as the renderer can do so without disturbing the animation and then
	 * persisted once the unit ends, so it survives a spinner or task log that
	 * clears on completion.
	 */
	warn(label: string, value?: string): void;
}

/** Drives a quantitative progress bar over a known total. */
export interface ProgressHandle {
	/** Advance the bar by `step` units (default 1), optionally retitling it. */
	advance(step?: number, message?: string): void;
	/** Annotate the bar with a live key/value, like {@link PhaseContext.fact}. */
	fact(label: string, value: string | number): void;
	/** Raise a durable warning that belongs to this unit; see {@link PhaseContext.warn}. */
	warn(label: string, value?: string): void;
}

export interface ProgressOptions {
	/** The value the bar reaches when the work is complete. */
	readonly total: number;
}

/** One named group of sub-steps within a {@link StepLog}. */
export interface StepGroup {
	message(message: string): void;
	success(message: string): void;
	error(message: string): void;
}

/** A task whose body reports grouped sub-steps as it runs. */
export interface StepLog {
	message(message: string): void;
	group(name: string): StepGroup;
	/** Raise a durable warning that belongs to this task; see {@link PhaseContext.warn}. */
	warn(label: string, value?: string): void;
}

export interface ResultRow {
	readonly label: string;
	readonly value: string;
}

/**
 * A command's result, carried in both shapes the two modes need. Terminal mode
 * renders `rows` as a card; JSON mode emits `{event:'result', kind, data}`,
 * where `kind` is a stable machine name for the result and `data` is the typed
 * value behind it, so a consumer can address it without re-parsing the rows.
 */
export interface ResultPayload<T = unknown> {
	readonly kind: string;
	readonly data: T;
	readonly rows: readonly ResultRow[];
	/**
	 * Shown in terminal mode when `rows` is empty, in place of an empty card, so a
	 * list command can always emit a result (an empty `data` for machine
	 * consumers) while still reading nicely for a person ("No tenants.").
	 */
	readonly empty?: string;
}

export interface Reporter {
	/** A unit of work shown as a spinner with live qualitative facts. */
	phase<T>(
		label: string,
		body: (context: PhaseContext) => Promise<T> | T
	): Promise<T>;
	/** A unit of work shown as a progress bar over a known total. */
	progress<T>(
		label: string,
		options: ProgressOptions,
		body: (bar: ProgressHandle) => Promise<T> | T
	): Promise<T>;
	/** A unit of work shown as a task with grouped sub-steps. */
	steps<T>(label: string, body: (log: StepLog) => Promise<T> | T): Promise<T>;
	result(payload: ResultPayload): void;
	/**
	 * Writes a raw payload, followed by a newline, to stdout in both terminal and
	 * JSON modes. This is the reporter's only stdout sink: progress, results and
	 * diagnostics all go to stderr, so a payload written here can be redirected on
	 * its own (`cupboard pubkey <url> > key.txt`).
	 */
	data(text: string): void;
	warn(label: string, value?: string): void;
	info(message: string): void;
	/**
	 * Reports a sub-step that completed its work: a green marker line in terminal
	 * mode, or one `{event:'success', message}` in JSON mode.
	 */
	success(message: string): void;
	/**
	 * Reports a sub-step that was skipped because there was nothing to do: a
	 * neutral marker line in terminal mode, or one `{event:'step', message}` in
	 * JSON mode.
	 */
	step(message: string): void;
	/**
	 * Reports a terminal failure: a red marker line in terminal mode, with the
	 * error's `cause` chain indented under it, or one `{event:'error', name,
	 * message}` in JSON mode, with an added `causes` array when the error has a
	 * `cause`.
	 */
	error(error: unknown): void;
}

/** Terminal (clack), line-delimited JSON, or GitHub Actions output. */
export type ReporterMode = 'terminal' | 'json' | 'github';

/**
 * The phases `cupboard build-push` reports, in run order, each with the label
 * its {@link Reporter.phase} unit carries in every mode. A machine consumer of
 * the JSON stream addresses a phase event by its label.
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
	 * Where progress and diagnostics are written, one line at a time; defaults to
	 * `process.stderr`. Tests can pass an in-memory `node:stream.Writable` to
	 * assert on the output.
	 */
	readonly stream?: NodeJS.WritableStream;
	/**
	 * Where `data` payloads are written; defaults to `process.stdout`. Kept
	 * separate from `stream` so a payload can be redirected without the progress
	 * output. Tests can pass an in-memory stream to assert on it.
	 */
	readonly out?: NodeJS.WritableStream;
	/** The clock used for durations and progress throttling; defaults to `Date.now`. */
	readonly now?: () => number;
	/**
	 * An absolute path to append one JSONL result event to for every
	 * {@link Reporter.result}, in every mode. Read the file back with
	 * {@link parseReporterResults}.
	 */
	readonly resultFile?: string;
}

/** One result event as persisted to a `--result-file`, carrying its machine payload. */
export const reporterResultEventSchema = z.strictObject({
	kind: z.string(),
	data: z.unknown()
});

export type ReporterResultEvent = z.infer<typeof reporterResultEventSchema>;

/** Thrown by {@link parseReporterResults} for a line that is not a valid result event. */
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

// A no-op when no result file is configured, otherwise an appender bound to it,
// so each reporter's `result` can record unconditionally.
function resultAppender(resultFile?: string): (payload: ResultPayload) => void {
	if (resultFile === undefined) {
		return () => {
			/* no result file: nothing to persist */
		};
	}

	return (payload) => {
		appendResultEvent(resultFile, payload);
	};
}

function warnText(label: string, value?: string): string {
	return value === undefined ? label : `${label}: ${value}`;
}

// A long progress phase emits an interim `progress` event at most this often, so
// a machine consumer (a CI log) sees a transfer advancing continuously, without
// one event per byte.
const progressIntervalMs = 2000;

/**
 * The line-delimited JSON reporter: the machine-readable contract. Terminal
 * rendering lives in `@cupboard/cli-ui`, which selects it for machine mode.
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
 * The GitHub Actions reporter: phases and tasks become collapsible log groups,
 * facts and results plain `label: value` lines within them, warnings, successes
 * and failures the matching workflow-command annotations. Its output is the
 * run log on stdout; it participates in the result file like the other modes.
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
			// Measured from the start, so a phase short enough to finish within one
			// interval emits no interim event, only the final summary.
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
			// Measured from the start, so a phase short enough to finish within one
			// interval emits no interim event, only the final summary.
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

// Splits any thrown value into the fields of the JSON error event. `causes` is
// omitted when the error has no cause, so an event for such an error keeps its
// two fields.
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

		// commands.error escapes newlines, so the multi-line text stays one
		// annotation.
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
			// Measured from the start, so a phase short enough to finish within one
			// interval emits no interim line, only the final summary.
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
