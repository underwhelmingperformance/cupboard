import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Writable } from 'node:stream';

import { parseReporterResults, type ReporterMode } from '@cupboard/reporter';
import pc from 'picocolors';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	type CliUi,
	type CliUiOptions,
	ConfirmationRequiredError,
	createCliUi,
	formatRows,
	isInteractive,
	resultTitle,
	terminalLink
} from './cli-ui.ts';
import { fakeCliUi } from './testing.ts';

const escape = String.fromCodePoint(27);
const plain = pc.createColors(false);

/** Collects everything written to an in-memory stream. */
function captureStream(): { stream: Writable; written: () => string } {
	const chunks: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(String(chunk));
			callback();
		}
	});

	return { stream, written: () => chunks.join('') };
}

const durationEventSchema = z.looseObject({ durationMs: z.number() });

function withoutDurations(events: readonly unknown[]): readonly unknown[] {
	return events.map((event) => {
		const parsed = durationEventSchema.safeParse(event);

		return parsed.success ? { ...parsed.data, durationMs: 'number' } : event;
	});
}

describe('formatRows', () => {
	it('aligns values to the widest label', () => {
		const formatted = formatRows(
			[
				{ label: 'Account', value: 'acc-1' },
				{ label: 'Custom domain', value: 'cache.example.com' }
			],
			plain
		);

		expect(formatted).toBe(
			['Account        acc-1', 'Custom domain  cache.example.com'].join('\n')
		);
	});

	it('renders a single row without padding beyond its own label', () => {
		expect(formatRows([{ label: 'Account', value: 'acc-1' }], plain)).toBe(
			'Account  acc-1'
		);
	});

	it('dims the label with ANSI when colour is enabled', () => {
		const coloured = formatRows(
			[{ label: 'Account', value: 'acc-1' }],
			pc.createColors(true)
		);

		expect(coloured).toBe(`${pc.createColors(true).dim('Account')}  acc-1`);
	});
});

describe('resultTitle', () => {
	it.each([
		['tenants', 'Tenants'],
		['auth-keys', 'Auth keys'],
		['retention-policies', 'Retention policies'],
		['oidc-trust-rules', 'OIDC trust rules'],
		['push-summary', 'Push summary'],
		['', 'Result']
	])('renders %s as %s', (kind, expected) => {
		expect(resultTitle(kind)).toBe(expected);
	});
});

describe('terminalLink', () => {
	it('wraps the text in an OSC 8 hyperlink to the URL', () => {
		const bel = String.fromCodePoint(7);

		expect(terminalLink('cupboard', 'https://example.com')).toBe(
			`${escape}]8;;https://example.com${bel}cupboard${escape}]8;;${bel}`
		);
	});
});

describe('isInteractive', () => {
	it.each([
		{ mode: 'terminal', stdin: true, stdout: true, expected: true },
		{ mode: 'terminal', stdin: true, stdout: false, expected: false },
		{ mode: 'terminal', stdin: false, stdout: true, expected: false },
		{ mode: 'json', stdin: true, stdout: true, expected: false }
	] as const)(
		'$mode mode with stdin=$stdin stdout=$stdout is $expected',
		({ mode, stdin, stdout, expected }) => {
			expect(
				isInteractive({
					mode,
					stdin: { isTTY: stdin },
					stdout: { isTTY: stdout }
				})
			).toBe(expected);
		}
	);
});

/** A machine-mode UI whose JSON output is captured for assertions. */
function machineUi(overrides: Partial<CliUiOptions> = {}): {
	ui: CliUi;
	out: () => string;
	stream: () => string;
} {
	const payload = captureStream();
	const diagnostics = captureStream();
	const ui = createCliUi({
		mode: 'json' satisfies ReporterMode,
		interactive: false,
		out: payload.stream,
		stream: diagnostics.stream,
		...overrides
	});

	return { ui, out: payload.written, stream: diagnostics.written };
}

describe('createCliUi confirm', () => {
	it('throws when non-interactive without --yes', async () => {
		const { ui } = machineUi();

		await expect(
			ui.confirm({ message: 'Remove tenant acme?' })
		).rejects.toThrow(ConfirmationRequiredError);
	});

	it('proceeds and narrates when non-interactive with a per-call --yes', async () => {
		const { ui, stream } = machineUi();

		const outcome = await ui.confirm({
			message: 'Remove tenant acme?',
			assumeYes: true
		});

		expect(outcome).toBe('yes');
		expect(JSON.parse(stream().trim())).toStrictEqual({
			event: 'info',
			message: 'Remove tenant acme? (proceeding: --yes)'
		});
	});

	it('proceeds when the UI was built with assumeYes', async () => {
		const { ui } = machineUi({ assumeYes: true });

		expect(await ui.confirm({ message: 'Remove tenant acme?' })).toBe('yes');
	});
});

describe('createCliUi machine narration', () => {
	it('keeps decorative narration silent and routes data to stdout', () => {
		const { ui, out, stream } = machineUi();

		ui.intro('cupboard');
		ui.outro('done');
		ui.note('Plan', [{ label: 'Tenant', value: 'acme' }]);
		ui.data('payload-line');
		ui.info('a diagnostic');

		expect(out()).toBe('payload-line\n');
		expect(
			stream()
				.trim()
				.split('\n')
				.map((line): unknown => JSON.parse(line))
		).toStrictEqual([{ event: 'info', message: 'a diagnostic' }]);
	});

	it('reports a non-interactive menu as no choice', async () => {
		const { ui } = machineUi();

		expect(await ui.menu('Pick', [{ value: 'a', label: 'A' }])).toBeUndefined();
	});

	it('hands out one shared reporter so narration and work units coordinate', () => {
		const { ui } = machineUi();

		expect(ui.reporter()).toBe(ui.reporter());
	});

	it('routes progress and steps through the JSON reporter', async () => {
		const { ui, stream } = machineUi();
		const reporter = ui.reporter();

		await reporter.progress('Uploading', { total: 2 }, (bar) => {
			bar.advance(2);
		});
		await reporter.steps('Attestations', (log) => {
			log.group('read').success('1 bundle');
		});

		const events = stream()
			.trim()
			.split('\n')
			.map((line): unknown => JSON.parse(line));

		expect(withoutDurations(events)).toStrictEqual([
			{
				event: 'phase',
				label: 'Uploading',
				status: 'ok',
				durationMs: 'number',
				total: 2,
				completed: 2,
				facts: {}
			},
			{
				event: 'phase',
				label: 'Attestations',
				status: 'ok',
				durationMs: 'number',
				groups: [{ name: 'read', status: 'ok', messages: ['1 bundle'] }]
			}
		]);
	});
});

describe('createCliUi reporter routing', () => {
	it('routes github mode to the github reporter', () => {
		const payload = captureStream();
		const ui = createCliUi({
			mode: 'github' satisfies ReporterMode,
			interactive: false,
			out: payload.stream
		});

		ui.reporter().result({
			kind: 'push-summary',
			data: { uploaded: 5 },
			rows: [{ label: 'paths', value: '5' }]
		});

		expect(payload.written()).toBe('paths: 5\n');
	});
});

describe('createCliUi result file', () => {
	it.each(['json', 'github'] as const)(
		'appends result events in %s mode',
		(mode: ReporterMode) => {
			const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-cli-ui-'));
			const resultFile = path.join(directory, 'results.jsonl');
			const payload = captureStream();
			const diagnostics = captureStream();

			try {
				createCliUi({
					mode,
					interactive: false,
					out: payload.stream,
					stream: diagnostics.stream,
					resultFile
				})
					.reporter()
					.result({
						kind: 'push-summary',
						data: { uploaded: 5 },
						rows: [{ label: 'paths', value: '5' }]
					});

				expect(
					parseReporterResults(readFileSync(resultFile, 'utf8'))
				).toStrictEqual([{ kind: 'push-summary', data: { uploaded: 5 } }]);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	);

	it('appends result events in terminal mode', () => {
		const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-cli-ui-'));
		const resultFile = path.join(directory, 'results.jsonl');
		// Clack renders the result card straight to `process.stdout`; swallow it so
		// the assertion is about the result file, not the terminal drawing.
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

		try {
			createCliUi({
				mode: 'terminal' satisfies ReporterMode,
				interactive: false,
				resultFile
			})
				.reporter()
				.result({
					kind: 'push-summary',
					data: { uploaded: 5 },
					rows: [{ label: 'paths', value: '5' }]
				});

			expect(
				parseReporterResults(readFileSync(resultFile, 'utf8'))
			).toStrictEqual([{ kind: 'push-summary', data: { uploaded: 5 } }]);
		} finally {
			vi.restoreAllMocks();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe('fakeCliUi', () => {
	it('records narration and answers prompts from its script', async () => {
		const { ui, captured } = fakeCliUi({
			interactive: true,
			confirm: 'yes',
			menu: 'b'
		});

		ui.intro('cupboard');
		ui.data('out');
		const confirmed = await ui.confirm({ message: 'Proceed?' });
		const chosen = await ui.menu('Pick', [
			{ value: 'a', label: 'A' },
			{ value: 'b', label: 'B' }
		]);

		expect({ confirmed, chosen, captured }).toStrictEqual({
			confirmed: 'yes',
			chosen: 'b',
			captured: {
				intros: ['cupboard'],
				outros: [],
				cancellations: [],
				infos: [],
				successes: [],
				steps: [],
				warnings: [],
				notes: [],
				data: ['out'],
				confirms: [{ message: 'Proceed?' }],
				results: [],
				errors: [],
				opened: []
			}
		});
	});
});
