import { stderr, stdout } from 'node:process';

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
	 * Reports a terminal failure: a single red marker line in terminal mode, or
	 * one `{event:'error', name, message}` in JSON mode.
	 */
	error(error: unknown): void;
}

/** Terminal (clack) or line-delimited JSON output. */
export type ReporterMode = 'terminal' | 'json';

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
		options.now ?? (() => Date.now())
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
	now: () => number
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

			try {
				const value = await body({
					fact(factLabel, factValue) {
						facts[factLabel] = String(factValue);
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

// Splits any thrown value into the name and message the reporter renders.
function describeError(error: unknown): { name: string; message: string } {
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}

	return { name: 'Error', message: String(error) };
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
