import { appendFileSync } from 'node:fs';
import { env, stderr, stdout } from 'node:process';

import { errorCauses, formatErrorWithCauses } from '@cupboard/shared/errors';
import {
	type CommandStream,
	workflowCommands
} from '@cupboard/shared/github-actions';
import { z } from 'zod';

const reportedErrors = new WeakSet<object>();

class ThrownValueError extends Error {}

function reportableError(error: unknown): Error {
	return error instanceof Error
		? error
		: new ThrownValueError(formatErrorWithCauses(error));
}

/**
 * Records an error object's identity globally so another reporter can suppress
 * a duplicate diagnostic. A primitive value is not recorded. The GitHub
 * reporter's phases wrap a thrown primitive in an `Error` before they record
 * and rethrow it, so the Actions handler receives the recorded object.
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

export type PresentationLevel = 'summary' | 'details' | 'debug';

export interface LabelPresentation {
	readonly humanLabel?: string;
}

export interface MessagePresentation {
	readonly humanMessage?: string;
	readonly level?: 'details' | 'debug';
}

export interface FactPresentation extends LabelPresentation {
	readonly humanValue?: string | number;
	readonly level?: 'details' | 'debug';
}

export function shouldShowDetails(
	reporter: Pick<Reporter, 'presentation'>
): boolean {
	return (
		reporter.presentation === 'details' || reporter.presentation === 'debug'
	);
}

export function shouldShowDebug(
	reporter: Pick<Reporter, 'presentation'>
): boolean {
	return reporter.presentation === 'debug';
}

export function shouldDisplay(
	presentation: PresentationLevel = 'summary',
	level?: 'details' | 'debug'
): boolean {
	if (level === undefined) {
		return true;
	}
	if (level === 'debug') {
		return presentation === 'debug';
	}
	return presentation !== 'summary';
}

export interface PhaseContext {
	fact(
		label: string,
		value: string | number,
		presentation?: FactPresentation
	): void;
	/**
	 * Reports a warning for this unit. JSON and GitHub modes emit it immediately.
	 * Terminal spinners and progress bars defer it until the animation ends; a
	 * task log shows it live and repeats it after the task closes.
	 */
	warn(label: string, value?: string, presentation?: MessagePresentation): void;
	/**
	 * Reports a result of this phase. Each mode outputs it when the phase ends,
	 * whether the phase succeeds or fails. GitHub mode writes it inside the
	 * phase's group after the facts. Terminal mode renders it after the spinner
	 * stops, and JSON mode emits it after the phase event.
	 */
	result(payload: ResultPayload): void;
}

export interface ProgressHandle {
	/**
	Advance the bar by `step` units (default 1), optionally retitling it.
	*/
	advance(step?: number, message?: string): void;
	/**
	Adds or replaces a live key/value annotation.
	*/
	fact(
		label: string,
		value: string | number,
		presentation?: FactPresentation
	): void;
	/**
	Records a warning for this unit; see {@link PhaseContext.warn}.
	*/
	warn(label: string, value?: string, presentation?: MessagePresentation): void;
}

export interface ProgressOptions extends LabelPresentation {
	readonly total: number;
}

export interface StepGroup {
	message(message: string, presentation?: MessagePresentation): void;
	success(message: string, presentation?: MessagePresentation): void;
	error(message: string, presentation?: MessagePresentation): void;
}

export interface StepLog {
	message(message: string, presentation?: MessagePresentation): void;
	group(name: string, presentation?: LabelPresentation): StepGroup;
	/**
	Records a warning for this task; see {@link PhaseContext.warn}.
	*/
	warn(label: string, value?: string, presentation?: MessagePresentation): void;
}

export interface ResultRow {
	readonly label: string;
	readonly value: string;
	readonly raw?: boolean;
}

export interface ResultColumn<K extends string> {
	readonly key: K;
	readonly label: string;
}

/**
 * A table cell that links to a page. The job summary renders it as a markdown
 * link. Terminal and GitHub modes print {@link ResultLink.plainText}.
 */
export class ResultLink {
	constructor(
		readonly text: string,
		readonly url: URL
	) {}

	/**
	The link text followed by the URL in parentheses.
	*/
	get plainText(): string {
		return `${this.text} (${this.url.href})`;
	}
}

export type ResultCell = string | ResultLink;

function plainCellText(cell: ResultCell): string {
	return typeof cell === 'string' ? cell : cell.plainText;
}

/**
 * A display-only table with one cell in each row for every column, in column
 * order. Build one with {@link ResultTable.of}.
 */
export class ResultTable {
	/**
	 * Builds a table from rows keyed by the columns' keys. The columns specify
	 * the keys read from each row. Every row must provide those keys, and other
	 * properties are ignored.
	 */
	static of<const K extends string>(
		columns: readonly ResultColumn<K>[],
		rows: readonly Readonly<Record<NoInfer<K>, ResultCell>>[]
	): ResultTable {
		return new ResultTable(
			columns.map((column) => column.label),
			rows.map((row) => columns.map((column) => row[column.key]))
		);
	}

	private constructor(
		readonly columns: readonly string[],
		readonly rows: readonly (readonly ResultCell[])[]
	) {}

	/**
	 * Returns the column labels and then each row as plain text, with the cells
	 * padded to align the columns. `measure` gives a cell's display width.
	 */
	lines(measure: (text: string) => number = (text) => text.length): string[] {
		const textRows = [
			this.columns,
			...this.rows.map((row) => row.map((cell) => plainCellText(cell)))
		];
		const widths = this.columns.map((_label, index) =>
			Math.max(...textRows.map((row) => measure(row[index] ?? '')))
		);

		return textRows.map((cells) =>
			cells
				.map(
					(cell, index) =>
						`${cell}${' '.repeat((widths[index] ?? 0) - measure(cell))}`
				)
				.join('  ')
				.trimEnd()
		);
	}
}

/**
 * `kind` and `data` are the stable machine result. JSON mode emits them as a
 * result event, and every mode appends them to `resultFile` when configured.
 * The other fields are display-only.
 *
 * Terminal mode renders `rows`, `table` and `code` as a card. GitHub mode
 * writes the title, then `rows` as `label: value` lines, then `table` as
 * aligned columns, then the lines of `code`. When a phase reports the result
 * through {@link PhaseContext.result}, GitHub mode writes it inside the phase's
 * group.
 */
export interface ResultPayload<T = unknown> {
	readonly kind: string;
	readonly title?: string;
	readonly data: T;
	readonly rows: readonly ResultRow[];
	readonly table?: ResultTable;
	/**
	 * Text to print verbatim after the rows and the table, such as
	 * configuration lines for the reader to copy.
	 */
	readonly code?: string;
	/**
	 * A sentence after `code`, made of text and links. The job summary writes it
	 * as a paragraph with markdown links, and the other modes print each link as
	 * {@link ResultLink.plainText}.
	 */
	readonly note?: readonly ResultCell[];
	/**
	 * Terminal and GitHub modes render this text when `rows`, `table`, `code`
	 * and `note` are all empty. JSON mode still emits the empty `data` value.
	 */
	readonly empty?: string;
	/**
	 * When this is true and `GITHUB_STEP_SUMMARY` is set, GitHub mode also
	 * appends the result to that file as markdown: a heading from the title, a
	 * two-column table for `rows`, a table for `table` and a fenced code block
	 * for `code`. The other modes ignore it.
	 */
	readonly jobSummary?: boolean;
}

/**
 * Returns a result's `note` as plain text, or `undefined` when it has none.
 */
export function resultNoteText(
	payload: Pick<ResultPayload, 'note'>
): string | undefined {
	if (payload.note === undefined || payload.note.length === 0) {
		return undefined;
	}

	return payload.note.map((cell) => plainCellText(cell)).join('');
}

/**
 * Splits a result's `code` into lines and removes one trailing line break.
 * Returns an empty list when `code` is missing or empty.
 */
export function resultCodeLines(
	payload: Pick<ResultPayload, 'code'>
): string[] {
	if (payload.code === undefined || payload.code === '') {
		return [];
	}

	return payload.code.replace(/\r?\n$/u, '').split(/\r?\n/u);
}

export interface Reporter {
	readonly presentation?: PresentationLevel;
	phase<T>(
		label: string,
		body: (context: PhaseContext) => Promise<T> | T,
		presentation?: LabelPresentation
	): Promise<T>;
	progress<T>(
		label: string,
		options: ProgressOptions,
		body: (bar: ProgressHandle) => Promise<T> | T
	): Promise<T>;
	steps<T>(
		label: string,
		body: (log: StepLog) => Promise<T> | T,
		presentation?: LabelPresentation
	): Promise<T>;
	result(payload: ResultPayload): void;
	/**
	 * Writes a raw payload followed by a newline to `out`. Every mode keeps `out`
	 * separate from its progress rendering, so a caller can capture the payload.
	 */
	data(text: string): void;
	warn(label: string, value?: string, presentation?: MessagePresentation): void;
	info(message: string, presentation?: MessagePresentation): void;
	/**
	 * Reports completed work as a terminal success marker, a JSON `success` event,
	 * or a GitHub notice when workflow commands are active.
	 */
	success(message: string, presentation?: MessagePresentation): void;
	/**
	 * Reports skipped work as a terminal step marker, a JSON `step` event, or a
	 * plain GitHub log line.
	 */
	step(message: string, presentation?: MessagePresentation): void;
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
	readonly presentation?: PresentationLevel;
	/**
	 * Destination for JSON events and GitHub rendering. Defaults to stderr.
	 */
	readonly stream?: NodeJS.WritableStream;
	/**
	 * Destination for `data` payloads. Defaults to stdout.
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
	/**
	 * Formats GitHub error annotations without changing the thrown error.
	 * Defaults to the error message and its causes.
	 */
	readonly formatError?: (error: unknown) => string;
	/**
	 * The environment from which GitHub mode reads `GITHUB_STEP_SUMMARY`.
	 * Defaults to `process.env`.
	 */
	readonly environment?: Readonly<Record<string, string | undefined>>;
	/**
	 * Appends text to a file. Every mode uses it for `resultFile`, and GitHub
	 * mode also uses it for the job summary. Defaults to `appendFileSync`.
	 */
	readonly appendFile?: (path: string, text: string) => void;
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
	payload: ResultPayload,
	appendFile: (path: string, text: string) => void = appendFileSync
): void {
	appendFile(
		resultFile,
		`${JSON.stringify({ kind: payload.kind, data: payload.data })}\n`
	);
}

function resultAppender(
	options: Pick<ReporterOptions, 'resultFile' | 'appendFile'>
): (payload: ResultPayload) => void {
	const { resultFile, appendFile } = options;

	if (resultFile === undefined) {
		return () => {
			// Intentionally empty result appender.
		};
	}

	return (payload) => {
		appendResultEvent(resultFile, payload, appendFile);
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
		resultAppender(options),
		options.presentation ?? 'summary'
	);
}

/**
 * Renders to `stream`, which defaults to stderr, and writes `data` payloads to
 * `out`, which defaults to stdout. The runner reads workflow commands from
 * both streams. When `GITHUB_ACTIONS=true`, phases and tasks use workflow
 * groups and warnings, successes and failures use command annotations.
 * Otherwise the shared command emitter degrades them to plain lines. Results
 * use `label: value` lines and aligned table columns in either environment,
 * and a result marked with `jobSummary` is also appended to the job summary.
 */
export function createGithubReporter(options: ReporterOptions = {}): Reporter {
	return buildGithubReporter(options);
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
	recordResult: (payload: ResultPayload) => void,
	presentation: PresentationLevel
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

	function emitResult(payload: ResultPayload): void {
		emit({ event: 'result', kind: payload.kind, data: payload.data });
		recordResult(payload);
	}

	return {
		presentation,
		async phase(label, body) {
			const facts: Record<string, string> = {};
			const results: ResultPayload[] = [];
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
					warn: emitWarn,
					result(payload) {
						results.push(payload);
					}
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
			} finally {
				for (const payload of results) {
					emitResult(payload);
				}
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

		result: emitResult,

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

function buildGithubReporter(options: ReporterOptions): Reporter {
	const presentation = options.presentation ?? 'summary';
	const stream = options.stream ?? stderr;
	const out = options.out ?? stdout;
	const now = options.now ?? (() => Date.now());
	const recordResult = resultAppender(options);
	const appendJobSummary = jobSummaryAppender(options);
	const formatError = options.formatError ?? formatErrorWithCauses;

	// Write through `counted` so `endGroup` can tell whether anything appeared
	// in a group.
	let writes = 0;
	const counted: CommandStream = {
		write(chunk) {
			writes += 1;
			return stream.write(chunk);
		}
	};
	const commands = workflowCommands({
		stdout: counted,
		stderr: counted,
		rendering: 'workflow'
	});
	const line = (text: string): void => {
		counted.write(`${text}\n`);
	};

	const emitWarn = (
		label: string,
		value?: string,
		display?: MessagePresentation
	): void => {
		if (!shouldDisplay(presentation, display?.level)) {
			return;
		}
		commands.warning(display?.humanMessage ?? warnText(label, value));
	};
	const humanLine = (message: string, display?: MessagePresentation): void => {
		if (!shouldDisplay(presentation, display?.level)) {
			return;
		}
		line(display?.humanMessage ?? message);
	};

	const emitFacts = (facts: ReadonlyMap<string, string>): void => {
		for (const [label, value] of facts) {
			line(`${label}: ${value}`);
		}
	};

	const writeResult = (payload: ResultPayload): void => {
		if (payload.title !== undefined) {
			line(payload.title);
		}

		const lines = [
			...payload.rows.map((row) => `${row.label}: ${row.value}`),
			...(payload.table === undefined || payload.table.rows.length === 0
				? []
				: payload.table.lines()),
			...resultCodeLines(payload),
			...[resultNoteText(payload)].filter((text) => text !== undefined)
		];

		if (lines.length === 0 && payload.empty !== undefined) {
			line(payload.empty);
		}
		for (const text of lines) {
			line(text);
		}

		recordResult(payload);
		appendJobSummary(payload);
	};

	// Writes a duration line into a successful group that would otherwise be
	// empty. A failed group closes with `commands.endGroup` instead, because a
	// duration line there would read as success.
	const endGroup = (openedAtWrite: number, startedAt: number): void => {
		if (writes === openedAtWrite) {
			line(`Completed in ${formatDuration(now() - startedAt)}`);
		}
		commands.endGroup();
	};

	const addGroup = (name: string, display?: LabelPresentation): StepGroup => {
		line(`${display?.humanLabel ?? name}:`);

		return {
			message: (message, display) => {
				if (!shouldDisplay(presentation, display?.level)) {
					return;
				}
				line(`  ${display?.humanMessage ?? message}`);
			},
			success: (message, display) => {
				if (!shouldDisplay(presentation, display?.level)) {
					return;
				}
				line(`  ${display?.humanMessage ?? message}`);
			},
			error: (message, display) => {
				if (!shouldDisplay(presentation, display?.level)) {
					return;
				}
				line(`  ${display?.humanMessage ?? message}`);
			}
		};
	};
	const emitError = (error: unknown): Error => {
		const reportedError = reportableError(error);

		if (wasErrorReported(reportedError)) {
			return reportedError;
		}

		// commands.error escapes newlines, so the multi-line text stays one
		// annotation.
		commands.error(formatError(reportedError));
		markErrorReported(reportedError);

		return reportedError;
	};

	return {
		presentation,
		async phase<T>(
			label: string,
			body: (context: PhaseContext) => Promise<T> | T,
			display?: LabelPresentation
		): Promise<T> {
			commands.group(display?.humanLabel ?? label);

			const openedAtWrite = writes;
			const startedAt = now();
			const facts = new Map<string, string>();
			const results: ResultPayload[] = [];
			const writeOutcome = (): void => {
				emitFacts(facts);
				for (const payload of results) {
					writeResult(payload);
				}
			};

			let value: T;

			try {
				value = await body({
					fact(factLabel, factValue, display) {
						if (!shouldDisplay(presentation, display?.level)) {
							return;
						}
						facts.set(
							display?.humanLabel ?? factLabel,
							String(display?.humanValue ?? factValue)
						);
					},
					warn: emitWarn,
					result(payload) {
						results.push(payload);
					}
				});
			} catch (error) {
				writeOutcome();
				const reportedError = emitError(error);
				commands.endGroup();

				throw reportedError;
			}

			writeOutcome();
			endGroup(openedAtWrite, startedAt);

			return value;
		},

		async progress(label, options, body) {
			const humanLabel = options.humanLabel ?? label;
			commands.group(humanLabel);

			const facts = new Map<string, string>();
			const startedAt = now();
			// Start the interval clock with the phase, so short phases emit only the
			// final line.
			let lastEmitAt = startedAt;
			let completed = 0;

			const summary = (): string =>
				`${humanLabel}: ${String(completed)}/${String(options.total)}`;

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
					fact(factLabel, factValue, display) {
						if (!shouldDisplay(presentation, display?.level)) {
							return;
						}
						facts.set(
							display?.humanLabel ?? factLabel,
							String(display?.humanValue ?? factValue)
						);
					},
					warn: emitWarn
				});

				emitFacts(facts);
				line(summary());
				commands.endGroup();

				return value;
			} catch (error) {
				emitFacts(facts);
				const reportedError = emitError(error);
				commands.endGroup();

				throw reportedError;
			}
		},

		async steps(label, body, display) {
			commands.group(display?.humanLabel ?? label);

			const openedAtWrite = writes;
			const startedAt = now();

			try {
				const value = await body({
					message: humanLine,
					group: addGroup,
					warn: emitWarn
				});

				endGroup(openedAtWrite, startedAt);

				return value;
			} catch (error) {
				const reportedError = emitError(error);
				commands.endGroup();

				throw reportedError;
			}
		},

		result: writeResult,

		data(text) {
			writes += 1;
			out.write(`${text}\n`);
		},

		warn: emitWarn,

		info: humanLine,

		success(message, display) {
			if (!shouldDisplay(presentation, display?.level)) {
				return;
			}
			commands.notice(display?.humanMessage ?? message);
		},

		step: humanLine,

		error(error) {
			emitError(error);
		}
	};
}

function jobSummaryAppender(
	options: Pick<ReporterOptions, 'environment' | 'appendFile'>
): (payload: ResultPayload) => void {
	const summaryFile = (options.environment ?? env).GITHUB_STEP_SUMMARY;

	if (summaryFile === undefined || summaryFile === '') {
		return () => {
			// Intentionally empty job summary appender.
		};
	}

	const appendFile = options.appendFile ?? appendFileSync;

	return (payload) => {
		if (payload.jobSummary !== true) {
			return;
		}

		appendFile(summaryFile, jobSummaryMarkdown(payload));
	};
}

function jobSummaryMarkdown(payload: ResultPayload): string {
	const rows = payload.rows.filter(
		(row) => row.label !== '' || row.value !== ''
	);
	const tables = [
		...(rows.length === 0
			? []
			: [
					markdownTable(
						['', ''],
						rows.map((row) => [row.label, row.value])
					)
				]),
		...(payload.table === undefined || payload.table.rows.length === 0
			? []
			: [markdownTable(payload.table.columns, payload.table.rows)])
	];
	const code = resultCodeLines(payload);
	const blocks = [
		...tables,
		...(code.length === 0 ? [] : [markdownCode(code)]),
		...(payload.note === undefined || payload.note.length === 0
			? []
			: [payload.note.map((cell) => markdownCell(cell)).join('')])
	];
	const body =
		blocks.length === 0 && payload.empty !== undefined
			? [markdownText(payload.empty)]
			: blocks;

	return [`### ${markdownText(payload.title ?? payload.kind)}`, ...body]
		.map((block) => `${block}\n\n`)
		.join('');
}

function markdownTable(
	columns: readonly string[],
	rows: readonly (readonly ResultCell[])[]
): string {
	return [
		markdownTableRow(columns.map((column) => markdownText(column))),
		markdownTableRow(columns.map(() => '---')),
		...rows.map((cells) =>
			markdownTableRow(cells.map((cell) => markdownCell(cell)))
		)
	].join('\n');
}

function markdownCell(cell: ResultCell): string {
	if (typeof cell === 'string') {
		return markdownText(cell);
	}

	// GitHub splits table cells at `|` before it parses links, and the URL
	// serialiser leaves `|` unencoded.
	const destination = cell.url.href.replaceAll('|', '%7C');

	return `[${markdownText(cell.text)}](<${destination}>)`;
}

// The fence must be longer than any run of backticks in the code, or that run
// would close the block early.
function markdownCode(lines: readonly string[]): string {
	const longestRun = Math.max(
		0,
		...lines.flatMap((text) =>
			(text.match(/`+/gu) ?? []).map((run) => run.length)
		)
	);
	const fence = '`'.repeat(Math.max(3, longestRun + 1));

	return [fence, ...lines, fence].join('\n');
}

function markdownTableRow(cells: readonly string[]): string {
	return `| ${cells.join(' | ')} |`;
}

// Escape the characters that start markdown inline syntax or end a table cell.
// A table cell must stay on one line, so line breaks become `<br>`.
function markdownText(text: string): string {
	return text
		.replaceAll(/[\\`*_[\]<>|~&]/g, String.raw`\$&`)
		.replaceAll(/\r\n|\r|\n/g, '<br>');
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
