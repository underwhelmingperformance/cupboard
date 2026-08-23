import type {
	Reporter,
	ResultPayload,
	ResultRow,
	StepGroup,
	StepLog
} from '@cupboard/reporter';

import type {
	CliUi,
	ConfirmOptions,
	ConfirmOutcome,
	MenuEntry,
	MultiSelectOptions,
	PrefixedTextOptions,
	TextEdit,
	TextEditOptions
} from './cli-ui.ts';

export interface CliUiCapture {
	readonly intros: string[];
	readonly outros: string[];
	readonly cancellations: string[];
	readonly infos: string[];
	readonly successes: string[];
	readonly steps: string[];
	readonly warnings: string[];
	readonly notes: { readonly title: string; readonly body: string }[];
	readonly data: string[];
	readonly confirms: ConfirmOptions[];
	readonly multiSelects: MultiSelectOptions<string>[];
	readonly results: ResultPayload[];
	readonly errors: unknown[];
	readonly opened: string[];
}

/**
 * Unspecified prompt answers default to cancellation, so a test only needs to
 * provide answers for the prompts its path reaches.
 */
export interface CliUiScript {
	readonly interactive?: boolean;
	readonly confirm?: ConfirmOutcome;
	readonly menu?: string;
	readonly multiSelects?: readonly (readonly string[] | undefined)[];
	readonly editText?: TextEdit;
	readonly prefixedText?: string;
	readonly secret?: string;
}

export interface FakeCliUi {
	readonly ui: CliUi;
	readonly captured: CliUiCapture;
}

const noop = (): void => {
	// Intentionally empty test callback.
};

const silentStepLog: StepLog = {
	message: noop,
	group: (): StepGroup => ({
		message: noop,
		success: noop,
		error: noop
	}),
	warn: noop
};

/**
 * Use this in command tests that need scripted prompts and captured output
 * without a terminal. Phases run their body directly, and results are captured
 * rather than rendered.
 */
export function fakeCliUi(script: CliUiScript = {}): FakeCliUi {
	const captured: CliUiCapture = {
		intros: [],
		outros: [],
		cancellations: [],
		infos: [],
		successes: [],
		steps: [],
		warnings: [],
		notes: [],
		data: [],
		confirms: [],
		multiSelects: [],
		results: [],
		errors: [],
		opened: []
	};

	const recordWarn = (label: string, value?: string): void => {
		captured.warnings.push(value === undefined ? label : `${label}: ${value}`);
	};
	let multiSelectIndex = 0;

	const reporter: Reporter = {
		phase: (_label, body) =>
			Promise.resolve(body({ fact: noop, warn: recordWarn })),
		progress: (_label, _options, body) =>
			Promise.resolve(body({ advance: noop, fact: noop, warn: recordWarn })),
		steps: (_label, body) =>
			Promise.resolve(body({ ...silentStepLog, warn: recordWarn })),
		result: (payload) => {
			captured.results.push(payload);
		},
		data: (text) => {
			captured.data.push(text);
		},
		warn: recordWarn,
		info: (message) => {
			captured.infos.push(message);
		},
		success: (message) => {
			captured.successes.push(message);
		},
		step: (message) => {
			captured.steps.push(message);
		},
		error: (error) => {
			captured.errors.push(error);
		}
	};

	const ui: CliUi = {
		interactive: script.interactive ?? false,

		intro: (title) => {
			captured.intros.push(title);
		},
		outro: (message) => {
			captured.outros.push(message);
		},
		cancelled: (message) => {
			captured.cancellations.push(message);
		},
		info: (message) => {
			captured.infos.push(message);
		},
		success: (message) => {
			captured.successes.push(message);
		},
		step: (message) => {
			captured.steps.push(message);
		},
		warn: (message) => {
			captured.warnings.push(message);
		},
		note: (title, rows) => {
			captured.notes.push({
				title,
				body: rows.map((row) => `${row.label}\t${row.value}`).join('\n')
			});
		},
		data: (text) => {
			captured.data.push(text);
		},

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

		multiSelect: <T extends string>(
			prompt: MultiSelectOptions<T>
		): Promise<readonly T[] | undefined> => {
			captured.multiSelects.push(prompt);
			const scripted = script.multiSelects?.[multiSelectIndex];
			multiSelectIndex += 1;

			if (scripted === undefined) {
				return Promise.resolve(undefined);
			}

			const selected = new Set(scripted);

			return Promise.resolve(
				prompt.entries
					.filter((entry) => selected.has(entry.value))
					.map((entry) => entry.value)
			);
		},

		editText: (_options: TextEditOptions): Promise<TextEdit> =>
			Promise.resolve(script.editText ?? { kind: 'cancelled' }),

		prefixedText: (
			_options: PrefixedTextOptions
		): Promise<string | undefined> => Promise.resolve(script.prefixedText),

		secret: (
			_message: string,
			_problem: (value: string) => string | undefined
		): Promise<string | undefined> => Promise.resolve(script.secret),

		openBrowser: (url) => {
			captured.opened.push(url);
		},

		reporter: () => reporter
	};

	return { ui, captured };
}

/**
 * Use this when a test needs result rows, information messages, and top-level
 * warnings without rendered output. It calls each phase, progress, and steps
 * body directly. Warnings raised inside those bodies, `data` payloads, and
 * errors are discarded; a test that needs them must provide its own reporter.
 */
export function capturingReporter(
	results: ResultRow[][],
	infos: string[] = [],
	warns: string[] = []
): Reporter {
	return {
		phase: (_label, body) => Promise.resolve(body({ fact: noop, warn: noop })),
		progress: (_label, _options, body) =>
			Promise.resolve(body({ advance: noop, fact: noop, warn: noop })),
		steps: (_label, body) => Promise.resolve(body(silentStepLog)),
		result: (payload) => {
			results.push([...payload.rows]);

			// Match terminal rendering by recording an empty result's message with
			// other informational lines.
			if (payload.rows.length === 0 && payload.empty !== undefined) {
				infos.push(payload.empty);
			}
		},
		data: noop,
		warn: (label, value) => {
			warns.push(value === undefined ? label : `${label}: ${value}`);
		},
		info: (message) => {
			infos.push(message);
		},
		success: (message) => {
			infos.push(message);
		},
		step: (message) => {
			infos.push(message);
		},
		error: noop
	};
}
