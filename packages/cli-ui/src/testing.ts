import type { Reporter, ResultPayload } from '@cupboard/reporter';

import type {
	CliUi,
	ConfirmOptions,
	ConfirmOutcome,
	MenuEntry,
	PrefixedTextOptions,
	TextEdit,
	TextEditOptions
} from './cli-ui.ts';

/** Everything a {@link FakeCliUi} recorded, for structural assertions. */
export interface CliUiCapture {
	readonly intros: string[];
	readonly outros: string[];
	readonly cancellations: string[];
	readonly infos: string[];
	readonly successes: string[];
	readonly warnings: string[];
	readonly notes: { readonly title: string; readonly body: string }[];
	readonly data: string[];
	readonly confirms: ConfirmOptions[];
	readonly results: ResultPayload[];
	readonly errors: unknown[];
	readonly opened: string[];
}

/**
 * The answers a {@link FakeCliUi} gives to prompts. Each defaults to a
 * cancellation, so a test scripts only the prompts its path reaches.
 */
export interface CliUiScript {
	readonly interactive?: boolean;
	readonly confirm?: ConfirmOutcome;
	readonly menu?: string;
	readonly editText?: TextEdit;
	readonly prefixedText?: string;
	readonly secret?: string;
}

export interface FakeCliUi {
	readonly ui: CliUi;
	readonly captured: CliUiCapture;
}

const recordFact = (): void => {
	/* the fake does not record phase facts */
};

/**
 * A {@link CliUi} that records every narration and answers prompts from a
 * script, for asserting on a command's output without a terminal. Phases run
 * their body straight through and results are captured rather than rendered.
 */
export function fakeCliUi(script: CliUiScript = {}): FakeCliUi {
	const captured: CliUiCapture = {
		intros: [],
		outros: [],
		cancellations: [],
		infos: [],
		successes: [],
		warnings: [],
		notes: [],
		data: [],
		confirms: [],
		results: [],
		errors: [],
		opened: []
	};

	const reporter: Reporter = {
		phase: (_label, body) => Promise.resolve(body({ fact: recordFact })),
		result: (payload) => captured.results.push(payload),
		data: (text) => captured.data.push(text),
		warn: (label, value) =>
			captured.warnings.push(
				value === undefined ? label : `${label}: ${value}`
			),
		info: (message) => captured.infos.push(message),
		error: (error) => captured.errors.push(error)
	};

	const ui: CliUi = {
		interactive: script.interactive ?? false,

		intro: (title) => captured.intros.push(title),
		outro: (message) => captured.outros.push(message),
		cancelled: (message) => captured.cancellations.push(message),
		info: (message) => captured.infos.push(message),
		success: (message) => captured.successes.push(message),
		warn: (message) => captured.warnings.push(message),
		note: (title, rows) =>
			captured.notes.push({
				title,
				body: rows.map((row) => `${row.label}\t${row.value}`).join('\n')
			}),
		data: (text) => captured.data.push(text),

		confirm: (options: ConfirmOptions): Promise<ConfirmOutcome> => {
			captured.confirms.push(options);
			return Promise.resolve(script.confirm ?? 'cancelled');
		},

		menu: <T extends string>(
			_message: string,
			entries: readonly MenuEntry<T>[]
		): Promise<T | undefined> =>
			Promise.resolve(
				entries.find((entry) => entry.value === script.menu)?.value
			),

		editText: (_options: TextEditOptions): Promise<TextEdit> =>
			Promise.resolve(script.editText ?? { kind: 'cancelled' }),

		prefixedText: (
			_options: PrefixedTextOptions
		): Promise<string | undefined> => Promise.resolve(script.prefixedText),

		secret: (
			_message: string,
			_problem: (value: string) => string | undefined
		): Promise<string | undefined> => Promise.resolve(script.secret),

		openBrowser: (url) => captured.opened.push(url),

		reporter: () => reporter
	};

	return { ui, captured };
}
