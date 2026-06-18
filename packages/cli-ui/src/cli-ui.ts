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
	createReporter,
	formatDuration,
	type Reporter,
	type ReporterMode,
	type ResultRow
} from '@cupboard/reporter';
import pc from 'picocolors';

import { type BrowserMessages, openBrowser } from './open-browser.ts';

export { type BrowserMessages, openBrowser } from './open-browser.ts';

// British spelling for the cancel marker clack renders when a spinner, bar or
// task is aborted without an explicit per-call message.
updateSettings({ messages: { cancel: 'Cancelled' } });

/**
 * Lays out label/value rows with aligned columns, ready for a clack note or box.
 * Labels are dimmed so the values carry the emphasis.
 */
export function formatRows(rows: readonly ResultRow[]): string {
	const width = Math.max(...rows.map((row) => row.label.length));

	return rows
		.map((row) =>
			row.label === '' && row.value === ''
				? ''
				: `${pc.dim(row.label.padEnd(width))}  ${row.value}`
		)
		.join('\n');
}

const OSC8 = `${String.fromCodePoint(0x1b)}]8;;`;
const BEL = String.fromCodePoint(0x07);

/**
 * An OSC 8 terminal hyperlink. Terminals that support it make `text`
 * clickable; the rest ignore the control sequence and just show `text`.
 */
export function terminalLink(text: string, url: string): string {
	return `${OSC8}${url}${BEL}${text}${OSC8}${BEL}`;
}

/** One choice in a menu prompt. */
export interface MenuEntry<T extends string> {
	readonly value: T;
	readonly label: string;
	readonly hint?: string;
}

/** The outcome of a text edit. */
export type TextEdit =
	| { readonly kind: 'set'; readonly value: string }
	| { readonly kind: 'clear' }
	| { readonly kind: 'cancelled' };

export interface TextEditOptions {
	readonly message: string;
	readonly initial?: string;
	readonly placeholder?: string;
	/** When true an empty answer means "clear"; otherwise it must validate. */
	readonly emptyClears?: boolean;
	/** Why the value is unacceptable, or undefined when it is fine. */
	readonly problem?: (value: string) => string | undefined;
}

export interface PrefixedTextOptions {
	readonly message: string;
	/** Rendered dimmed, immediately before the editable value. */
	readonly prefix: string;
	/** Why the value is unacceptable, or undefined when it is fine. */
	readonly problem: (value: string) => string | undefined;
}

/** The user's answer to a confirmation. */
export type ConfirmOutcome = 'yes' | 'no' | 'cancelled';

export interface ConfirmOptions {
	readonly message: string;
	/** Extra context shown above the prompt, e.g. what is about to be removed. */
	readonly detail?: string;
	/**
	 * Proceed without asking. A non-interactive run resolves `yes` only when this
	 * is set, so a piped or CI invocation never blocks on a prompt it cannot show.
	 */
	readonly assumeYes?: boolean;
}

/**
 * Thrown when a confirmation is needed but the run is non-interactive and
 * `--yes` was not given: there is no terminal to prompt on, so the command
 * fails loudly rather than blocking or silently proceeding.
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

/** A stream's terminal status; both `process.stdin` and `process.stdout` fit. */
interface TtyStream {
	readonly isTTY?: boolean;
}

/**
 * Whether prompts can be shown: only when the output is the terminal UI and both
 * ends of the pipe are a real terminal. A piped or redirected run is not
 * interactive even with `--colour`, so a prompt would have nowhere to go.
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
 * Everything a cupboard command says or asks, in one clack-based visual
 * language: spinners for phases, notes for structured facts, prompts for the
 * decisions, and a clean cancel path throughout. The same surface drives the
 * machine mode, where the decorative narration falls silent and the structured
 * output flows through {@link CliUi.reporter}.
 */
export interface CliUi {
	/** Whether {@link CliUi.confirm} and the prompts can interact with the user. */
	readonly interactive: boolean;
	intro(title: string): void;
	outro(message: string): void;
	cancelled(message: string): void;
	info(message: string): void;
	/** Reports a step that completed its work. */
	success(message: string): void;
	/** Reports a step skipped because there was nothing to do. */
	step(message: string): void;
	warn(message: string): void;
	note(title: string, rows: readonly ResultRow[]): void;
	/** Writes a payload to stdout; delegates to {@link Reporter.data}. */
	data(text: string): void;
	/** Ask the user to confirm a (typically destructive) action. */
	confirm(options: ConfirmOptions): Promise<ConfirmOutcome>;
	/** Pick from a menu; undefined when cancelled or non-interactive. */
	menu<T extends string>(
		message: string,
		entries: readonly MenuEntry<T>[]
	): Promise<T | undefined>;
	/** Edit a single text value. */
	editText(options: TextEditOptions): Promise<TextEdit>;
	/**
	 * Ask for a value typed inline after a fixed prefix (a URL the value
	 * completes, say). There is no default; undefined when cancelled.
	 */
	prefixedText(options: PrefixedTextOptions): Promise<string | undefined>;
	/** Ask for a secret value, masked; undefined when cancelled. */
	secret(
		message: string,
		problem: (value: string) => string | undefined
	): Promise<string | undefined>;
	openBrowser(url: string): void;
	/**
	 * A {@link Reporter} for this command's phases and results: clack spinners in
	 * terminal mode, line-delimited JSON in machine mode.
	 */
	reporter(): Reporter;
}

export interface CliUiOptions {
	readonly mode: ReporterMode;
	/** Treat confirmations as already accepted (the `--yes` flag). */
	readonly assumeYes?: boolean;
	/**
	 * Override the computed interactivity. Defaults to {@link isInteractive} over
	 * the process streams; tests pass it explicitly.
	 */
	readonly interactive?: boolean;
	/** Where progress and diagnostics go; defaults to `process.stderr`. */
	readonly stream?: NodeJS.WritableStream;
	/** Where `data` payloads go; defaults to `process.stdout`. */
	readonly out?: NodeJS.WritableStream;
	/**
	 * Aborts the active spinner, bar or task so an interrupted command (Ctrl-C)
	 * renders it as cancelled.
	 */
	readonly signal?: AbortSignal;
}

export function createCliUi(options: CliUiOptions): CliUi {
	const { mode } = options;
	const assumeYesDefault = options.assumeYes ?? false;
	// A continuous-integration run is never interactive, even when it captures a
	// terminal: there is no human at the keyboard to answer a prompt.
	const interactive =
		options.interactive ?? (isInteractive({ mode, stdin, stdout }) && !isCI());
	// One reporter per UI, shared between the UI's own narration and every
	// `ui.reporter()` caller. There is a single terminal, so the spinner state and
	// the queue that holds narration back while a spinner animates have to be
	// shared: a phase started through `ui.reporter()` and an `info` raised through
	// the UI are output to the same place and must not corrupt each other's
	// redraw. In machine mode it also means both paths emit the same structured
	// events.
	const reporter: Reporter =
		mode === 'terminal'
			? clackReporter(options.out, options.signal)
			: createReporter({ stream: options.stream, out: options.out });

	const browserMessages: BrowserMessages = {
		info: (message) => {
			ui.info(message);
		},
		warn: (message) => {
			ui.warn(message);
		}
	};

	const ui: CliUi = {
		interactive,

		intro(title) {
			if (mode === 'terminal') {
				intro(pc.bold(title));
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
				note(formatRows(rows), title);
			}
		},

		data(text) {
			reporter.data(text);
		},

		async confirm(request) {
			if (interactive) {
				return confirmInteractive(request);
			}

			if (request.assumeYes ?? assumeYesDefault) {
				reporter.info(`${request.message} (proceeding: --yes)`);
				return 'yes';
			}

			throw new ConfirmationRequiredError(request.message);
		},

		async menu(message, entries) {
			if (!interactive) {
				return;
			}

			const choice = await select<string>({
				message,
				options: entries.map((entry) => ({
					value: entry.value,
					label: entry.label,
					...(entry.hint === undefined ? {} : { hint: entry.hint })
				}))
			});

			if (isCancel(choice)) {
				return;
			}

			// Resolve back through the entries so the value keeps its narrow type.
			return entries.find((entry) => entry.value === choice)?.value;
		},

		async editText(options) {
			if (!interactive) {
				return { kind: 'cancelled' };
			}

			const answer = await text({
				message: options.message,
				initialValue: options.initial ?? '',
				...(options.placeholder === undefined
					? {}
					: { placeholder: options.placeholder }),
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
			if (!interactive) {
				return;
			}

			const prompt: TextPrompt = new TextPrompt({
				validate: (value = '') => options.problem(value),
				render: () => {
					const title = `${pc.gray(S_BAR)}\n${symbol(prompt.state)}  ${options.message}\n`;
					const typed = `${pc.dim(options.prefix)}${prompt.userInputWithCursor}`;
					const settled = options.prefix + (prompt.value ?? '');

					switch (prompt.state) {
						case 'submit': {
							return `${title}${pc.gray(S_BAR)}  ${pc.dim(settled)}`;
						}

						case 'cancel': {
							return `${title}${pc.gray(S_BAR)}  ${pc.strikethrough(pc.dim(settled))}\n${pc.gray(S_BAR)}`;
						}

						case 'error': {
							const detail =
								prompt.error === '' ? '' : `  ${pc.yellow(prompt.error)}`;

							return `${title.trim()}\n${pc.yellow(S_BAR)}  ${typed}\n${pc.yellow(S_BAR_END)}${detail}\n`;
						}

						default: {
							return `${title}${pc.cyan(S_BAR)}  ${typed}\n${pc.cyan(S_BAR_END)}\n`;
						}
					}
				}
			});

			const answer = await prompt.prompt();

			return isCancel(answer) || typeof answer !== 'string'
				? undefined
				: answer;
		},

		async secret(message, problem) {
			if (!interactive) {
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

		reporter() {
			return reporter;
		}
	};

	return ui;
}

// Slug words that are acronyms, so a result title renders them in capitals
// (`oidc-trust-rules` becomes `OIDC trust rules`, not `Oidc trust rules`).
const titleAcronyms = new Set(['oidc']);

/** A result `kind` slug as a heading: `tenant-list` becomes `Tenant list`. */
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

// The label followed by its accumulated facts, dimmed, for a spinner or bar
// title. Facts are keyed by label, so a repeated fact (an attempt counter,
// say) updates its entry and the title stays bounded.
function renderFacts(
	label: string,
	facts: ReadonlyMap<string, string>
): string {
	if (facts.size === 0) {
		return label;
	}

	const annotations = [...facts.entries()]
		.map(([factLabel, value]) => `${factLabel} ${value}`)
		.join(' · ');

	return `${label} ${pc.dim(`· ${annotations}`)}`;
}

// A completion line with its elapsed time appended, dimmed, so every phase,
// bar and task reports how long it took at a precision that suits the duration.
function withElapsed(message: string, startedAt: number): string {
	return `${message} ${pc.dim(`(${formatDuration(Date.now() - startedAt)})`)}`;
}

function warnText(label: string, value?: string): string {
	return value === undefined ? label : `${label}: ${value}`;
}

interface UnitNotes {
	warn: (label: string, value?: string) => void;
	flush: () => void;
}

/**
 * Collects the durable warnings a unit of work raises while it animates. clack
 * draws one region at a time and a {@link log.warn} written into a live spinner
 * or task log corrupts its redraw, so the warnings are emitted once the unit
 * ends, when nothing is animating. A `live` sink, where the unit has a surface
 * that can show them in place (a task log), previews each one as it arrives.
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

/**
 * Adapts the {@link Reporter} contract onto clack: a {@link Reporter.phase} is a
 * spinner whose title accumulates its facts, {@link Reporter.progress} a progress
 * bar, {@link Reporter.steps} a task log with grouped sub-steps, and a
 * {@link Reporter.result} a framed card. Narration outside a unit prints straight
 * away; a durable warning raised inside one is held by {@link unitNotes} and
 * emitted when the unit stops, so it survives a region that clears on success.
 */
function clackReporter(
	out: NodeJS.WritableStream = stdout,
	signal?: AbortSignal
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
						indicator.message(renderFacts(label, facts));
					},
					warn: notes.warn
				});

				indicator.stop(withElapsed(renderFacts(label, facts), startedAt));

				return value;
			} catch (error) {
				indicator.error(withElapsed(`${label} ${pc.red('failed')}`, startedAt));

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
						bar.advance(step, message ?? renderFacts(label, facts));
					},
					fact(factLabel, factValue) {
						facts.set(factLabel, String(factValue));
						bar.message(renderFacts(label, facts));
					},
					warn: notes.warn
				});

				bar.stop(withElapsed(renderFacts(label, facts), startedAt));

				return value;
			} catch (error) {
				bar.error(withElapsed(`${label} ${pc.red('failed')}`, startedAt));

				throw error;
			} finally {
				notes.flush();
			}
		},

		async steps(label, body) {
			const task = taskLog({ title: label, signal });

			const notes = unitNotes((message) => {
				task.message(`${pc.yellow(S_WARN)} ${message}`);
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

				task.success(withElapsed(label, startedAt));

				return value;
			} catch (error) {
				task.error(withElapsed(`${label} ${pc.red('failed')}`, startedAt));

				throw error;
			} finally {
				notes.flush();
			}
		},

		result(payload) {
			if (payload.rows.length === 0) {
				if (payload.empty !== undefined) {
					log.info(payload.empty);
				}

				return;
			}

			box(formatRows(payload.rows), resultTitle(payload.kind));
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
			log.error(error instanceof Error ? error.message : String(error));
		}
	};
}
