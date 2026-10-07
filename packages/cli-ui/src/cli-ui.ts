import { stderr, stdin, stdout } from 'node:process';
import type { Writable } from 'node:stream';

import { getColumns, TextPrompt } from '@clack/core';
import {
	box,
	cancel,
	confirm,
	intro,
	isCancel,
	isCI,
	log,
	multiselect,
	note,
	outro,
	password,
	progress,
	S_BAR,
	S_BAR_END,
	S_WARN,
	select,
	spinner,
	symbol,
	taskLog,
	text,
	updateSettings
} from '@clack/prompts';
import {
	appendResultEvent,
	createGithubReporter,
	createReporter,
	formatDuration,
	type PresentationLevel,
	type Reporter,
	type ReporterMode,
	type ReporterOptions,
	type ResultPayload,
	type ResultRow,
	type ResultTable,
	shouldDisplay
} from '@cupboard/reporter';
import { errorCauses } from '@cupboard/shared/errors';
import stringWidth from 'fast-string-width';
import { wrapAnsi } from 'fast-wrap-ansi';
import pc from 'picocolors';

import { type BrowserMessages, openBrowser } from './open-browser.ts';

type Colours = ReturnType<typeof pc.createColors>;

export { clackSink } from './clack-sink.ts';
export { type BrowserMessages, openBrowser } from './open-browser.ts';
export { resolveReporterMode } from './reporter-mode.ts';

// British spelling for the cancel marker clack renders when a spinner, bar or
// task is aborted without an explicit per-call message. Clack only exposes this
// as a global mutation, so the CLI entrypoint calls this once at startup, before
// any prompt renders.
export function configureClackUi(): void {
	updateSettings({ messages: { cancel: 'Cancelled' } });
}

/**
 * Lays out label/value rows with aligned columns, ready for a clack note or box.
 * Labels are dimmed so the values carry the emphasis.
 */
export function formatRows(
	rows: readonly ResultRow[],
	colours: Colours = pc,
	contentWidth = 74
): string {
	if (rows.length === 0) {
		return '';
	}

	const columns = Math.max(3, Math.floor(contentWidth));
	const labelWidth = Math.max(...rows.map((row) => stringWidth(row.label)));
	const valueWidth = columns - labelWidth - 2;
	const isStacked = valueWidth < 24;
	const wrap = (value: string, width: number): string[] =>
		wrapAnsi(value, Math.max(1, width), { hard: true, trim: false }).split(
			'\n'
		);

	return rows
		.map((row) => {
			if (row.label === '' && row.value === '') {
				return '';
			}
			if (row.raw === true) {
				return row.label === ''
					? row.value
					: `${colours.dim(row.label)}\n${row.value}`;
			}
			if (isStacked) {
				const label = wrap(row.label, columns).map((line) => colours.dim(line));
				const value = wrap(row.value, columns - 2).map((line) => `  ${line}`);
				return [...label, ...value].join('\n');
			}
			const prefix = `${colours.dim(row.label)}${' '.repeat(labelWidth - stringWidth(row.label) + 2)}`;
			const continuation = ' '.repeat(labelWidth + 2);
			return wrap(row.value, valueWidth)
				.map((line, index) => `${index === 0 ? prefix : continuation}${line}`)
				.join('\n');
		})
		.join('\n');
}

function formatTable(table: ResultTable, colours: Colours): string {
	if (table.rows.length === 0) {
		return '';
	}

	const [header = '', ...rows] = table.lines(stringWidth);

	return [colours.dim(header), ...rows].join('\n');
}

function formatResult(
	payload: Pick<ResultPayload, 'rows' | 'table'>,
	colours: Colours,
	contentWidth: number
): string {
	return [
		formatRows(payload.rows, colours, contentWidth),
		payload.table === undefined ? '' : formatTable(payload.table, colours)
	]
		.filter((part) => part !== '')
		.join('\n\n');
}

function writeRows(
	output: Writable,
	title: string,
	payload: Pick<ResultPayload, 'rows' | 'table'>,
	colours: Colours
): void {
	output.write(
		`\n${colours.bold(title)}\n${formatResult(payload, colours, getColumns(output) - 6)}\n\n`
	);
}

const OSC8 = `${String.fromCodePoint(0x1b)}]8;;`;
const BEL = String.fromCodePoint(0x07);

/**
 * Emits the OSC 8 escape sequence that associates `text` with `url`. Whether
 * the text becomes clickable depends on the terminal's OSC 8 support.
 */
export function terminalLink(text: string, url: string): string {
	return `${OSC8}${url}${BEL}${text}${OSC8}${BEL}`;
}

export interface MenuEntry<T extends string> {
	readonly value: T;
	readonly label: string;
	readonly hint?: string;
}

export interface MultiSelectOptions<T extends string> {
	readonly message: string;
	readonly entries: readonly MenuEntry<T>[];
	readonly initialValues?: readonly T[];
}

export type TextEdit =
	| { readonly kind: 'set'; readonly value: string }
	| { readonly kind: 'clear' }
	| { readonly kind: 'cancelled' };

export interface TextEditOptions {
	readonly message: string;
	readonly initial?: string;
	readonly placeholder?: string;
	/**
	When true an empty answer means "clear"; otherwise it must validate.
	*/
	readonly emptyClears?: boolean;
	/**
	Why the value is unacceptable, or undefined when it is fine.
	*/
	readonly problem?: (value: string) => string | undefined;
	/**
	Closes the prompt, which then returns `cancelled`.
	*/
	readonly signal?: AbortSignal;
}

export interface PrefixedTextOptions {
	readonly message: string;
	/**
	Rendered dimmed, immediately before the editable value.
	*/
	readonly prefix: string;
	/**
	Why the value is unacceptable, or undefined when it is fine.
	*/
	readonly problem: (value: string) => string | undefined;
}

export type ConfirmOutcome = 'yes' | 'no' | 'cancelled';

export interface ConfirmOptions {
	readonly message: string;
	/**
	Extra context, such as the consequence of proceeding. It is shown above the
	prompt. When `assumeYes` applies, the detail is reported after the message.
	*/
	readonly detail?: string;
	/**
	 * Proceed without asking, whether or not the run can prompt. When this is
	 * undefined, the `assumeYes` option of `createCliUi` decides. If the effective
	 * `assumeYes` value is false, an interactive run prompts and a
	 * non-interactive run throws {@link ConfirmationRequiredError}.
	 */
	readonly assumeYes?: boolean;
}

/**
 * Thrown when a non-interactive command requires confirmation and `--yes` was
 * not given. The command cannot prompt, so it exits with a message that requires
 * `--yes`.
 */
export class ConfirmationRequiredError extends Error {
	constructor(message: string) {
		super(
			`${message} This is a destructive action; re-run with --yes to confirm.`
		);
		this.name = 'ConfirmationRequiredError';
	}
}

async function confirmInteractive(
	request: ConfirmOptions,
	output: Writable
): Promise<ConfirmOutcome> {
	if (request.detail !== undefined) {
		note(request.detail, request.message, { output });
	}

	const answer = await confirm({ message: request.message, output });

	if (isCancel(answer)) {
		return 'cancelled';
	}

	return answer ? 'yes' : 'no';
}

interface TtyStream {
	readonly isTTY?: boolean;
}

/**
 * Where Clack renders. A TTY, such as stderr, can also show prompts.
 */
type UiStream = Writable & TtyStream;

/**
 * Checks only whether the selected mode and streams can support prompts:
 * terminal mode with TTY stdin and stderr, where prompts render. Stdout does
 * not matter, so a prompt still works while stdout is captured.
 * {@link createCliUi} separately disables prompts when Clack reports a CI
 * environment.
 */
export function isInteractive(streams: {
	readonly mode: ReporterMode;
	readonly stdin: TtyStream;
	readonly stderr: TtyStream;
}): boolean {
	return (
		streams.mode === 'terminal' &&
		streams.stdin.isTTY === true &&
		streams.stderr.isTTY === true
	);
}

/**
 * Terminal mode uses Clack. JSON and GitHub modes suppress introductions,
 * conclusions and notes, then use the selected {@link CliUi.reporter}.
 */
export interface CliUi {
	/**
	 * When false, confirmations require `--yes` and the other prompt methods
	 * return their cancelled or undefined outcome without prompting.
	 */
	readonly interactive: boolean;
	intro(title: string): void;
	outro(message: string): void;
	cancelled(message: string): void;
	info(message: string): void;
	success(message: string): void;
	step(message: string): void;
	warn(message: string): void;
	note(title: string, rows: readonly ResultRow[]): void;
	/**
	 * Delegates to {@link Reporter.data}; `out` selects the destination.
	 */
	data(text: string): void;
	confirm(options: ConfirmOptions): Promise<ConfirmOutcome>;
	/**
	Returns undefined when cancelled or non-interactive.
	*/
	menu<T extends string>(
		message: string,
		entries: readonly MenuEntry<T>[]
	): Promise<T | undefined>;
	/**
	Returns undefined when cancelled or non-interactive.
	*/
	multiSelect<T extends string>(
		options: MultiSelectOptions<T>
	): Promise<readonly T[] | undefined>;
	editText(options: TextEditOptions): Promise<TextEdit>;
	/**
	 * Ask for a value typed inline after a fixed prefix (a URL the value
	 * completes, say). There is no default; undefined when cancelled.
	 */
	prefixedText(options: PrefixedTextOptions): Promise<string | undefined>;
	/**
	Masks the value and returns undefined when cancelled.
	*/
	secret(
		message: string,
		problem: (value: string) => string | undefined
	): Promise<string | undefined>;
	openBrowser(url: string): void;
	/**
	 * The command's shared reporter: Clack in terminal mode, line-delimited JSON
	 * in JSON mode, or GitHub rendering in GitHub mode.
	 */
	reporter(): Reporter;
}

export interface CliUiOptions {
	readonly mode: ReporterMode;
	/**
	 * Formats GitHub error annotations without changing the thrown error.
	 */
	readonly formatError?: ReporterOptions['formatError'];
	readonly presentation?: PresentationLevel;
	/**
	 * Whether to emit ANSI colour (the `--colour`/`--no-colour` flag). Defaults to
	 * picocolors' own detection over `NO_COLOR`, `FORCE_COLOR` and the TTY.
	 */
	readonly colour?: boolean;
	readonly assumeYes?: boolean;
	/**
	 * Overrides both the stream eligibility from {@link isInteractive} and
	 * Clack's CI check. Tests use this to exercise prompt-independent paths.
	 */
	readonly interactive?: boolean;
	/**
	 * Destination for everything but data: Clack's UI and prompts, JSON events
	 * and GitHub rendering. Defaults to stderr.
	 */
	readonly stream?: UiStream;
	/**
	 * Destination for data, so it can be captured alone. Defaults to stdout.
	 */
	readonly out?: NodeJS.WritableStream;
	/**
	 * A path to which every mode appends one JSONL event per result (the CLI's
	 * `--result-file`).
	 */
	readonly resultFile?: string;
	/**
	 * Aborts the active spinner, bar or task so an interrupted command (Ctrl-C)
	 * renders it as cancelled.
	 */
	readonly signal?: AbortSignal;
}

// Terminal mode uses Clack, JSON mode writes line-delimited events, and GitHub
// mode uses workflow-command syntax only when `GITHUB_ACTIONS=true`. Every mode
// records to the result file when one is configured.
function reporterFor(
	mode: ReporterMode,
	colours: Colours,
	options: CliUiOptions
): Reporter {
	if (mode === 'terminal') {
		return clackReporter(
			colours,
			options.stream,
			options.out,
			options.signal,
			options.resultFile,
			options.presentation,
			options.formatError
		);
	}

	if (mode === 'github') {
		return createGithubReporter({
			presentation: options.presentation,
			formatError: options.formatError,
			stream: options.stream,
			out: options.out,
			resultFile: options.resultFile
		});
	}

	return createReporter({
		presentation: options.presentation,
		stream: options.stream,
		out: options.out,
		resultFile: options.resultFile
	});
}

export function createCliUi(options: CliUiOptions): CliUi {
	const { mode } = options;
	const output: UiStream = options.stream ?? stderr;
	const colours = pc.createColors(options.colour ?? pc.isColorSupported);
	const isAssumeYesDefault = options.assumeYes ?? false;
	// `isInteractive` checks the streams. Clack's CI detection is a separate
	// reason to disable prompts even if a CI process has terminal streams.
	const isInteractiveRun =
		options.interactive ??
		(isInteractive({ mode, stdin, stderr: output }) && !isCI());
	// Clack has one live region. Share one reporter between UI narration and every
	// `ui.reporter()` caller so their updates do not corrupt its redraw. The same
	// sharing preserves event order in JSON and GitHub modes.
	const reporter: Reporter = reporterFor(mode, colours, options);

	const browserMessages: BrowserMessages = {
		info: (message) => {
			ui.info(message);
		},
		warn: (message) => {
			ui.warn(message);
		}
	};

	const ui: CliUi = {
		interactive: isInteractiveRun,

		intro(title) {
			if (mode === 'terminal') {
				intro(colours.bold(title), { output });
			}
		},

		outro(message) {
			if (mode === 'terminal') {
				outro(message, { output });
			}
		},

		cancelled(message) {
			if (mode === 'terminal') {
				cancel(message, { output });
				return;
			}

			reporter.info(message);
		},

		info(message) {
			reporter.info(message);
		},

		success(message) {
			reporter.success(message);
		},

		step(message) {
			reporter.step(message);
		},

		warn(message) {
			reporter.warn(message);
		},

		note(title, rows) {
			if (mode !== 'terminal') {
				return;
			}

			if (rows.some((row) => row.raw === true)) {
				writeRows(output, title, { rows }, colours);
				return;
			}
			note(formatRows(rows, colours, getColumns(output) - 6), title, {
				output
			});
		},

		data(text) {
			reporter.data(text);
		},

		async confirm(request) {
			if (request.assumeYes ?? isAssumeYesDefault) {
				reporter.info(`${request.message} (proceeding: --yes)`);

				if (request.detail !== undefined) {
					reporter.info(request.detail);
				}

				return 'yes';
			}

			if (isInteractiveRun) {
				return confirmInteractive(request, output);
			}

			throw new ConfirmationRequiredError(request.message);
		},

		async menu(message, entries) {
			if (!isInteractiveRun) {
				return;
			}

			const choice = await select<string>({
				message,
				output,
				options: entries.map((entry) => ({
					value: entry.value,
					label: entry.label,
					...(entry.hint !== undefined && { hint: entry.hint })
				}))
			});

			if (isCancel(choice)) {
				return;
			}

			return entries.find((entry) => entry.value === choice)?.value;
		},

		async multiSelect(options) {
			if (!isInteractiveRun) {
				return;
			}

			const choices = await multiselect<string>({
				message: options.message,
				output,
				options: options.entries.map((entry) => ({
					value: entry.value,
					label: entry.label,
					...(entry.hint !== undefined && { hint: entry.hint })
				})),
				initialValues: [...(options.initialValues ?? [])],
				required: false
			});

			if (isCancel(choices)) {
				return;
			}

			const selected = new Set(choices);

			return options.entries
				.filter((entry) => selected.has(entry.value))
				.map((entry) => entry.value);
		},

		async editText(options) {
			if (!isInteractiveRun) {
				return { kind: 'cancelled' };
			}

			const answer = await text({
				message: options.message,
				output,
				signal: options.signal,
				initialValue: options.initial ?? '',
				...(options.placeholder !== undefined && {
					placeholder: options.placeholder
				}),
				validate: (value = '') => {
					if (value === '') {
						return options.emptyClears === true
							? undefined
							: 'a value is required';
					}

					return options.problem?.(value);
				}
			});

			if (isCancel(answer)) {
				return { kind: 'cancelled' };
			}

			return answer === '' ? { kind: 'clear' } : { kind: 'set', value: answer };
		},

		async prefixedText(options) {
			if (!isInteractiveRun) {
				return;
			}

			const prompt: TextPrompt = new TextPrompt({
				output,
				validate: (value = '') => options.problem(value),
				render: () => {
					const title = `${colours.gray(S_BAR)}\n${symbol(prompt.state)}  ${options.message}\n`;
					const typed = `${colours.dim(options.prefix)}${prompt.userInputWithCursor}`;
					const settled = options.prefix + (prompt.value ?? '');

					switch (prompt.state) {
						case 'submit': {
							return `${title}${colours.gray(S_BAR)}  ${colours.dim(settled)}`;
						}

						case 'cancel': {
							return `${title}${colours.gray(S_BAR)}  ${colours.strikethrough(colours.dim(settled))}\n${colours.gray(S_BAR)}`;
						}

						case 'error': {
							const detail =
								prompt.error === '' ? '' : `  ${colours.yellow(prompt.error)}`;

							return `${title.trim()}\n${colours.yellow(S_BAR)}  ${typed}\n${colours.yellow(S_BAR_END)}${detail}\n`;
						}

						default: {
							return `${title}${colours.cyan(S_BAR)}  ${typed}\n${colours.cyan(S_BAR_END)}\n`;
						}
					}
				}
			});

			const answer = await prompt.prompt();

			return typeof answer !== 'string' || isCancel(answer)
				? undefined
				: answer;
		},

		async secret(message, problem) {
			if (!isInteractiveRun) {
				return;
			}

			const answer = await password({
				message,
				output,
				validate: (value) => problem(value ?? '')
			});

			return isCancel(answer) ? undefined : answer;
		},

		openBrowser(url) {
			openBrowser(url, browserMessages);
		},

		reporter: () => reporter
	};

	return ui;
}

// Preserve known acronyms when a result kind becomes a terminal heading. For
// example, `oidc-trust-rules` renders as `OIDC trust rules`.
const titleAcronyms = new Set(['oidc']);

export function resultTitle(kind: string): string {
	const words = kind.replaceAll(/[-_]+/g, ' ').trim().split(' ');
	const [first, ...rest] = words;

	if (first === undefined || first === '') {
		return 'Result';
	}

	const head = titleAcronyms.has(first)
		? first.toUpperCase()
		: first.slice(0, 1).toUpperCase() + first.slice(1);
	const tail = rest.map((word) =>
		titleAcronyms.has(word) ? word.toUpperCase() : word
	);

	return [head, ...tail].join(' ');
}

// Replace a fact with the same label instead of extending the spinner or bar
// title indefinitely, for example when an attempt counter changes.
function renderFacts(
	label: string,
	facts: ReadonlyMap<string, string>,
	colours: Colours
): string {
	if (facts.size === 0) {
		return label;
	}

	const annotations = [...facts]
		.map(([factLabel, value]) => `${factLabel} ${value}`)
		.join(' · ');

	return `${label} ${colours.dim(`· ${annotations}`)}`;
}

function withElapsed(
	message: string,
	startedAt: number,
	colours: Colours
): string {
	return `${message} ${colours.dim(`(${formatDuration(Date.now() - startedAt)})`)}`;
}

function warnText(label: string, value?: string): string {
	return value === undefined ? label : `${label}: ${value}`;
}

// Clack splits an error on newlines and draws its guide bar before each line.
// Indent and dim each cause so the whole chain remains attached to the main
// failure message.
function errorText(error: unknown, colours: Colours): string {
	const message = error instanceof Error ? error.message : String(error);

	return [
		message,
		...errorCauses(error).map((cause) => colours.dim(`  ${cause}`))
	].join('\n');
}

interface UnitNotes {
	warn: (label: string, value?: string) => void;
	flush: () => void;
}

/**
 * Clack has one live region, so spinners and progress bars buffer warnings until
 * their animation ends. A task log can show a warning inside its live region;
 * the warning is still repeated after the task closes so clearing or collapsing
 * the task cannot hide it.
 */
function unitNotes(
	output: Writable,
	live?: (message: string) => void
): UnitNotes {
	const pending: string[] = [];

	const warn = (label: string, value?: string): void => {
		const message = warnText(label, value);
		live?.(message);
		pending.push(message);
	};

	const flush = (): void => {
		for (const message of pending) {
			log.warn(message, { output });
		}
	};

	return { warn, flush };
}

function clackReporter(
	colours: Colours,
	output: Writable = stderr,
	out: NodeJS.WritableStream = stdout,
	signal?: AbortSignal,
	resultFile?: string,
	presentation: PresentationLevel = 'summary',
	formatError?: ReporterOptions['formatError']
): Reporter {
	const renderResult = (payload: ResultPayload): void => {
		if (resultFile !== undefined) {
			appendResultEvent(resultFile, payload);
		}

		const title = payload.title ?? resultTitle(payload.kind);

		if (payload.rows.length === 0 && (payload.table?.rows.length ?? 0) === 0) {
			if (payload.empty !== undefined) {
				log.info(payload.empty, { output });
			}

			return;
		}

		if (payload.rows.some((row) => row.raw === true)) {
			writeRows(output, title, payload, colours);
			return;
		}

		box(formatResult(payload, colours, getColumns(output) - 8), title, {
			output
		});
	};

	return {
		presentation,
		async phase(machineLabel, body, display) {
			const label = display?.humanLabel ?? machineLabel;
			const indicator = spinner({
				output,
				signal,
				cancelMessage: `${label} cancelled`
			});
			indicator.start(label);

			const notes = unitNotes(output);
			const startedAt = Date.now();
			const facts = new Map<string, string>();
			const results: ResultPayload[] = [];

			try {
				const value = await body({
					fact(factLabel, factValue, display) {
						if (!shouldDisplay(presentation, display?.level)) {
							return;
						}
						facts.set(
							display?.humanLabel ?? factLabel,
							String(display?.humanValue ?? factValue)
						);
						indicator.message(renderFacts(label, facts, colours));
					},
					warn: (label, value, display) => {
						if (!shouldDisplay(presentation, display?.level)) {
							return;
						}
						notes.warn(
							display?.humanMessage ?? label,
							display?.humanMessage === undefined ? value : undefined
						);
					},
					result(payload) {
						results.push(payload);
					}
				});

				indicator.stop(
					withElapsed(renderFacts(label, facts, colours), startedAt, colours)
				);

				return value;
			} catch (error) {
				indicator.error(
					withElapsed(`${label} ${colours.red('failed')}`, startedAt, colours)
				);

				throw error;
			} finally {
				notes.flush();
				for (const payload of results) {
					renderResult(payload);
				}
			}
		},

		async progress(machineLabel, options, body) {
			const label = options.humanLabel ?? machineLabel;
			const bar = progress({
				max: options.total,
				output,
				signal,
				cancelMessage: `${label} cancelled`
			});
			bar.start(label);

			const notes = unitNotes(output);
			const startedAt = Date.now();
			const facts = new Map<string, string>();

			try {
				const value = await body({
					advance(step = 1, message) {
						bar.advance(step, message ?? renderFacts(label, facts, colours));
					},
					fact(factLabel, factValue, display) {
						if (!shouldDisplay(presentation, display?.level)) {
							return;
						}
						facts.set(
							display?.humanLabel ?? factLabel,
							String(display?.humanValue ?? factValue)
						);
						bar.message(renderFacts(label, facts, colours));
					},
					warn: (label, value, display) => {
						if (!shouldDisplay(presentation, display?.level)) {
							return;
						}
						notes.warn(
							display?.humanMessage ?? label,
							display?.humanMessage === undefined ? value : undefined
						);
					}
				});

				bar.stop(
					withElapsed(renderFacts(label, facts, colours), startedAt, colours)
				);

				return value;
			} catch (error) {
				bar.error(
					withElapsed(`${label} ${colours.red('failed')}`, startedAt, colours)
				);

				throw error;
			} finally {
				notes.flush();
			}
		},

		async steps(machineLabel, body, display) {
			const label = display?.humanLabel ?? machineLabel;
			const task = taskLog({ title: label, output, signal });

			const notes = unitNotes(output, (message) => {
				task.message(`${colours.yellow(S_WARN)} ${message}`);
			});
			const startedAt = Date.now();

			try {
				const value = await body({
					message(message, display) {
						if (!shouldDisplay(presentation, display?.level)) {
							return;
						}
						task.message(display?.humanMessage ?? message);
					},
					group(name, display) {
						const group = task.group(display?.humanLabel ?? name);

						return {
							message: (message, display) => {
								if (!shouldDisplay(presentation, display?.level)) {
									return;
								}
								group.message(display?.humanMessage ?? message);
							},
							success: (message, display) => {
								if (!shouldDisplay(presentation, display?.level)) {
									return;
								}
								group.success(display?.humanMessage ?? message);
							},
							error: (message, display) => {
								if (!shouldDisplay(presentation, display?.level)) {
									return;
								}
								group.error(display?.humanMessage ?? message);
							}
						};
					},
					warn: (label, value, display) => {
						if (!shouldDisplay(presentation, display?.level)) {
							return;
						}
						notes.warn(
							display?.humanMessage ?? label,
							display?.humanMessage === undefined ? value : undefined
						);
					}
				});

				task.success(withElapsed(label, startedAt, colours));

				return value;
			} catch (error) {
				task.error(
					withElapsed(`${label} ${colours.red('failed')}`, startedAt, colours)
				);

				throw error;
			} finally {
				notes.flush();
			}
		},

		result: renderResult,

		data(text) {
			out.write(`${text}\n`);
		},

		warn(label, value, display) {
			if (!shouldDisplay(presentation, display?.level)) {
				return;
			}
			log.warn(display?.humanMessage ?? warnText(label, value), { output });
		},

		info(message, display) {
			if (!shouldDisplay(presentation, display?.level)) {
				return;
			}
			log.info(display?.humanMessage ?? message, { output });
		},

		success(message, display) {
			if (!shouldDisplay(presentation, display?.level)) {
				return;
			}
			log.success(display?.humanMessage ?? message, { output });
		},

		step(message, display) {
			if (!shouldDisplay(presentation, display?.level)) {
				return;
			}
			log.step(display?.humanMessage ?? message, { output });
		},

		error(error) {
			log.error(formatError?.(error) ?? errorText(error, colours), { output });
		}
	};
}
