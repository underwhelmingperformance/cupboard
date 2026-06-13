import { stderr } from 'node:process';

import Table from 'cli-table3';
import ora from 'ora';
import pc from 'picocolors';

export interface PhaseContext {
	fact(label: string, value: string | number): void;
}

export interface ResultRow {
	readonly label: string;
	readonly value: string;
}

export interface Reporter {
	phase<T>(
		label: string,
		body: (context: PhaseContext) => Promise<T> | T
	): Promise<T>;
	result(rows: readonly ResultRow[]): void;
	warn(label: string, value?: string): void;
	info(message: string): void;
}

/** Terminal (spinner) or line-delimited JSON output. */
export type ReporterMode = 'terminal' | 'json';

export interface ReporterOptions {
	/**
	 * Terminal (spinner) or JSON output. When omitted it is chosen from
	 * `process.stderr.isTTY`, not from an injected `stream`, so an injected
	 * non-TTY stream should set `mode` explicitly.
	 */
	readonly mode?: ReporterMode;
	/**
	 * Where output is written, one line at a time; defaults to `process.stderr`.
	 * Tests can pass an in-memory `node:stream.Writable` to assert on the output.
	 */
	readonly stream?: NodeJS.WritableStream;
}

export function createReporter(options: ReporterOptions = {}): Reporter {
	const stream = options.stream ?? stderr;
	const mode = options.mode ?? (stderr.isTTY ? 'terminal' : 'json');

	return mode === 'terminal'
		? createTerminalReporter(stream)
		: createJsonReporter(stream);
}

function createTerminalReporter(stream: NodeJS.WritableStream): Reporter {
	function writeLine(line: string): void {
		stream.write(`${line}\n`);
	}

	return {
		async phase(label, body) {
			const facts: { label: string; value: string }[] = [];
			const spinner = ora({ text: label, stream }).start();

			const renderSpinnerText = (): void => {
				spinner.text =
					facts.length === 0 ? label : `${label} · ${formatFacts(facts)}`;
			};

			const startedAt = Date.now();

			try {
				const value = await body({
					fact(factLabel, factValue) {
						facts.push({ label: factLabel, value: String(factValue) });
						renderSpinnerText();
					}
				});

				const elapsed = formatDuration(Date.now() - startedAt);
				const summary = facts.length === 0 ? '' : ` · ${formatFacts(facts)}`;
				spinner.succeed(`${label}${summary} ${pc.dim(`(${elapsed})`)}`);

				return value;
			} catch (error) {
				const elapsed = formatDuration(Date.now() - startedAt);
				spinner.fail(`${label} ${pc.red('failed')} ${pc.dim(`(${elapsed})`)}`);

				throw error;
			}
		},

		result(rows) {
			const table = new Table({
				chars: {
					top: '',
					'top-mid': '',
					'top-left': '',
					'top-right': '',
					bottom: '',
					'bottom-mid': '',
					'bottom-left': '',
					'bottom-right': '',
					left: '',
					'left-mid': '',
					right: '',
					'right-mid': '',
					mid: '',
					'mid-mid': '',
					middle: '  '
				},
				style: { 'padding-left': 0, 'padding-right': 0, border: [], head: [] }
			});

			for (const row of rows) {
				table.push([pc.dim(row.label), row.value]);
			}

			writeLine(table.toString());
		},

		warn(label, value) {
			writeLine(
				`${pc.yellow('!')} ${pc.yellow(label)}${value === undefined ? '' : ` ${value}`}`
			);
		},

		info(message) {
			writeLine(`${pc.dim('›')} ${message}`);
		}
	};
}

function createJsonReporter(stream: NodeJS.WritableStream): Reporter {
	function emit(event: Record<string, unknown>): void {
		stream.write(`${JSON.stringify(event)}\n`);
	}

	return {
		async phase(label, body) {
			const facts: Record<string, string> = {};
			const startedAt = Date.now();

			try {
				const value = await body({
					fact(factLabel, factValue) {
						facts[factLabel] = String(factValue);
					}
				});

				emit({
					event: 'phase',
					label,
					status: 'ok',
					durationMs: Date.now() - startedAt,
					facts
				});

				return value;
			} catch (error) {
				emit({
					event: 'phase',
					label,
					status: 'failed',
					durationMs: Date.now() - startedAt,
					error: error instanceof Error ? error.message : String(error)
				});

				throw error;
			}
		},

		result(rows) {
			const data: Record<string, string> = {};

			for (const row of rows) {
				data[row.label] = row.value;
			}

			emit({ event: 'result', data });
		},

		warn(label, value) {
			emit(
				value === undefined
					? { event: 'warn', label }
					: { event: 'warn', label, value }
			);
		},

		info(message) {
			emit({ event: 'info', message });
		}
	};
}

function formatFacts(
	facts: readonly { label: string; value: string }[]
): string {
	return facts
		.map(({ label, value }) => `${label} ${pc.cyan(value)}`)
		.join(', ');
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

export { default as colour } from 'picocolors';
export { default as formatBytes } from 'pretty-bytes';
