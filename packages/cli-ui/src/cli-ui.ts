import { stdin, stdout } from 'node:process';

import { TextPrompt } from '@clack/core';
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
	type Reporter,
	type ReporterMode,
	type ResultRow
} from '@cupboard/reporter';
import { errorCauses } from '@cupboard/shared/errors';
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
	colours: Colours = pc
): string {
	const width = Math.max(...rows.map((row) => row.label.length));

	return rows
		.map((row) =>
			row.label === '' && row.value === ''
				? ''
				: `${colours.dim(row.label.padEnd(width))}  ${row.value}`
		)
		.join('\n');
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
	Extra context shown above the prompt, e.g. what is about to be removed.
	*/
	readonly detail?: string;
	/**
	 * Proceed without asking. A non-interactive run resolves `yes` only when this
	 * is set, so a piped or CI invocation never blocks on a prompt it cannot show.
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
	request: ConfirmOptions
): Promise<ConfirmOutcome> {
	if (request.detail !== undefined) {
		note(request.detail, request.message);
	}

	const answer = await confirm({ message: request.message });

	if (isCancel(answer)) {
		return 'cancelled';
	}

	return answer ? 'yes' : 'no';
}

interface TtyStream {
	readonly isTTY?: boolean;
}

/**
 * Checks only whether the selected mode and streams can support prompts:
 * terminal mode with TTY stdin and stdout. {@link createCliUi} separately
 * disables prompts when Clack reports a CI environment.
 */
export function isInteractive(streams: {
	readonly mode: ReporterMode;
	readonly stdin: TtyStream;
	readonly stdout: TtyStream;
}): boolean {
	return (
		streams.mode === 'terminal' &&
		streams.stdin.isTTY === true &&
		streams.stdout.isTTY === true
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
	 * Destination for JSON events. Terminal and GitHub modes do not use it.
	 */
	readonly stream?: NodeJS.WritableStream;
	/**
	 * Destination for JSON and terminal data, and for all GitHub rendering.
	 * Defaults to stdout.
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
			options.out,
			options.signal,
			options.resultFile
		);
	}

	if (mode === 'github') {
		return createGithubReporter({
			out: options.out,
			resultFile: options.resultFile
		});
	}

	return createReporter({
		stream: options.stream,
		out: options.out,
		resultFile: options.resultFile
	});
}

export function createCliUi(options: CliUiOptions): CliUi {
	const { mode } = options;
	const colours = pc.createColors(options.colour ?? pc.isColorSupported);
	const isAssumeYesDefault = options.assumeYes ?? false;
	// `isInteractive` checks the streams. Clack's CI detection is a separate
	// reason to disable prompts even if a CI process has terminal streams.
	const isInteractiveRun =
		options.interactive ?? (isInteractive({ mode, stdin, stdout }) && !isCI());
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
				intro(colours.bold(title));
			}
		},

		outro(message) {
			if (mode === 'terminal') {
				outro(message);
			}
		},

		cancelled(message) {
			if (mode === 'terminal') {
				cancel(message);
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
			if (mode === 'terminal') {
				note(formatRows(rows, colours), title);
			}
		},

		data(text) {
			reporter.data(text);
		},

		async confirm(request) {
			if (isInteractiveRun) {
				return confirmInteractive(request);
			}

			if (request.assumeYes ?? isAssumeYesDefault) {
				reporter.info(`${request.message} (proceeding: --yes)`);
				return 'yes';
			}

			throw new ConfirmationRequiredError(request.message);
		},

		async menu(message, entries) {
			if (!isInteractiveRun) {
				return;
			}

			const choice = await select<string>({
				message,
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
function unitNotes(live?: (message: string) => void): UnitNotes {
	const pending: string[] = [];

	const warn = (label: string, value?: string): void => {
		const message = warnText(label, value);
		live?.(message);
		pending.push(message);
	};

	const flush = (): void => {
		for (const message of pending) {
			log.warn(message);
		}
	};

	return { warn, flush };
}

function clackReporter(
	colours: Colours,
	out: NodeJS.WritableStream = stdout,
	signal?: AbortSignal,
	resultFile?: string
): Reporter {
	return {
		async phase(label, body) {
			const indicator = spinner({
				signal,
				cancelMessage: `${label} cancelled`
			});
			indicator.start(label);

			const notes = unitNotes();
			const startedAt = Date.now();
			const facts = new Map<string, string>();

			try {
				const value = await body({
					fact(factLabel, factValue) {
						facts.set(factLabel, String(factValue));
						indicator.message(renderFacts(label, facts, colours));
					},
					warn: notes.warn
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
			}
		},

		async progress(label, options, body) {
			const bar = progress({
				max: options.total,
				signal,
				cancelMessage: `${label} cancelled`
			});
			bar.start(label);

			const notes = unitNotes();
			const startedAt = Date.now();
			const facts = new Map<string, string>();

			try {
				const value = await body({
					advance(step = 1, message) {
						bar.advance(step, message ?? renderFacts(label, facts, colours));
					},
					fact(factLabel, factValue) {
						facts.set(factLabel, String(factValue));
						bar.message(renderFacts(label, facts, colours));
					},
					warn: notes.warn
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

		async steps(label, body) {
			const task = taskLog({ title: label, signal });

			const notes = unitNotes((message) => {
				task.message(`${colours.yellow(S_WARN)} ${message}`);
			});
			const startedAt = Date.now();

			try {
				const value = await body({
					message(message) {
						task.message(message);
					},
					group(name) {
						const group = task.group(name);

						return {
							message: (message) => {
								group.message(message);
							},
							success: (message) => {
								group.success(message);
							},
							error: (message) => {
								group.error(message);
							}
						};
					},
					warn: notes.warn
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

		result(payload) {
			if (resultFile !== undefined) {
				appendResultEvent(resultFile, payload);
			}

			if (payload.rows.length === 0) {
				if (payload.empty !== undefined) {
					log.info(payload.empty);
				}

				return;
			}

			box(formatRows(payload.rows, colours), resultTitle(payload.kind));
		},

		data(text) {
			out.write(`${text}\n`);
		},

		warn(label, value) {
			log.warn(warnText(label, value));
		},

		info(message) {
			log.info(message);
		},

		success(message) {
			log.success(message);
		},

		step(message) {
			log.step(message);
		},

		error(error) {
			log.error(errorText(error, colours));
		}
	};
}
