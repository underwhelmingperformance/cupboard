import { stdout } from 'node:process';

import { TextPrompt } from '@clack/core';
import {
	cancel,
	intro,
	isCancel,
	log,
	note,
	outro,
	password,
	S_BAR,
	S_BAR_END,
	select,
	spinner,
	symbol,
	text
} from '@clack/prompts';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import pc from 'picocolors';

import { openBrowser } from '../io/open-browser.ts';

import type { AccountSummary } from './cloudflare-api.ts';

/**
 * Lays out label/value rows with aligned columns, ready for a clack note.
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

/**
 * An OSC 8 terminal hyperlink. Terminals that support it make `text`
 * clickable; the rest ignore the control sequence and just show `text`.
 */
export function terminalLink(text: string, url: string): string {
	return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
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

/**
 * Everything `cupboard deploy` says or asks. One clack-based visual language
 * for the whole command: spinners for phases, notes for structured facts,
 * prompts for the decisions, and a clean cancel path throughout.
 */
export interface DeployUi {
	intro(): void;
	outro(message: string): void;
	cancelled(message: string): void;
	info(message: string): void;
	success(message: string): void;
	warn(message: string): void;
	note(title: string, rows: readonly ResultRow[]): void;
	/** Pick from a menu; undefined when the prompt is cancelled. */
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
	/** Undefined when cancelled. */
	chooseAccount(
		accounts: readonly AccountSummary[]
	): Promise<string | undefined>;
	openBrowser(url: string): void;
	/** A {@link Reporter} rendering phases as clack spinners. */
	reporter(): Reporter;
}

export function createDeployUi(): DeployUi {
	return {
		intro() {
			intro(pc.bold('cupboard deploy'));
		},

		outro(message) {
			outro(message);
		},

		cancelled(message) {
			cancel(message);
		},

		info(message) {
			log.info(message);
		},

		success(message) {
			log.success(message);
		},

		warn(message) {
			log.warn(message);
		},

		note(title, rows) {
			note(formatRows(rows), title);
		},

		async menu(message, entries) {
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
			const answer = await new TextPrompt({
				validate: (value = '') => options.problem(value),
				render() {
					const title = `${pc.gray(S_BAR)}\n${symbol(this.state)}  ${options.message}\n`;
					const typed = `${pc.dim(options.prefix)}${this.userInputWithCursor}`;
					const settled = options.prefix + (this.value ?? '');

					switch (this.state) {
						case 'submit': {
							return `${title}${pc.gray(S_BAR)}  ${pc.dim(settled)}`;
						}

						case 'cancel': {
							return `${title}${pc.gray(S_BAR)}  ${pc.strikethrough(pc.dim(settled))}\n${pc.gray(S_BAR)}`;
						}

						case 'error': {
							const detail =
								this.error === '' ? '' : `  ${pc.yellow(this.error)}`;

							return `${title.trim()}\n${pc.yellow(S_BAR)}  ${typed}\n${pc.yellow(S_BAR_END)}${detail}\n`;
						}

						default: {
							return `${title}${pc.cyan(S_BAR)}  ${typed}\n${pc.cyan(S_BAR_END)}\n`;
						}
					}
				}
			}).prompt();

			return isCancel(answer) || typeof answer !== 'string'
				? undefined
				: answer;
		},

		async secret(message, problem) {
			const answer = await password({
				message,
				validate: (value) => problem(value ?? '')
			});

			return isCancel(answer) ? undefined : answer;
		},

		async chooseAccount(accounts) {
			const chosen = await select({
				message: 'Which Cloudflare account?',
				options: accounts.map((account) => ({
					value: account.id,
					label: account.name,
					hint: account.id
				}))
			});

			return isCancel(chosen) ? undefined : chosen;
		},

		openBrowser(url) {
			openBrowser(url, {
				info: (message) => {
					log.info(message);
				},
				warn: (message) => {
					log.warn(message);
				}
			});
		},

		reporter() {
			return clackReporter();
		}
	};
}

/**
 * Adapts the deploy pipeline's {@link Reporter} contract onto clack: each
 * phase is a spinner whose text accumulates the phase's facts, warnings become
 * clack warnings, and the closing result rows become a note. A warning or
 * info raised while a spinner is animating is held until the spinner stops,
 * since interleaving the two corrupts the spinner's redraw.
 */
function clackReporter(): Reporter {
	let spinning = false;
	const held: { kind: 'warn' | 'info'; message: string }[] = [];

	const emit = (kind: 'warn' | 'info', message: string): void => {
		if (spinning) {
			held.push({ kind, message });
			return;
		}

		if (kind === 'warn') {
			log.warn(message);
		} else {
			log.info(message);
		}
	};

	const flush = (): void => {
		for (const entry of held.splice(0)) {
			emit(entry.kind, entry.message);
		}
	};

	return {
		async phase(label, body) {
			const indicator = spinner();
			indicator.start(label);
			spinning = true;

			// Keyed by fact label, so a repeated fact (an attempt counter, say)
			// updates its entry rather than growing the spinner text unboundedly.
			const facts = new Map<string, string>();
			const rendered = (): string =>
				facts.size === 0
					? label
					: `${label} ${pc.dim(
							`· ${[...facts.entries()]
								.map(([factLabel, value]) => `${factLabel} ${value}`)
								.join(' · ')}`
						)}`;

			try {
				const value = await body({
					fact(factLabel, factValue) {
						facts.set(factLabel, String(factValue));
						indicator.message(rendered());
					}
				});

				indicator.stop(rendered());

				return value;
			} catch (error) {
				indicator.error(`${label} ${pc.red('failed')}`);

				throw error;
			} finally {
				spinning = false;
				flush();
			}
		},

		result(rows) {
			note(formatRows(rows), 'Deployed');
		},

		data(text) {
			stdout.write(`${text}\n`);
		},

		warn(label, value) {
			emit('warn', value === undefined ? label : `${label}: ${value}`);
		},

		info(message) {
			emit('info', message);
		},

		error(error) {
			log.error(error instanceof Error ? error.message : String(error));
		}
	};
}
