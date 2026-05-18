import { stderr } from 'node:process';
import type { WriteStream } from 'node:tty';

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

export interface ReporterOptions {
	readonly mode?: 'terminal' | 'json';
	readonly stream?: WriteStream;
}

export function createReporter(options: ReporterOptions = {}): Reporter {
	const stream = options.stream ?? stderr;
	const mode = options.mode ?? (stream.isTTY ? 'terminal' : 'json');

	return mode === 'terminal'
		? createTerminalReporter(stream)
		: createJsonReporter(stream);
}

function createTerminalReporter(stream: WriteStream): Reporter {
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

function createJsonReporter(stream: WriteStream): Reporter {
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

export { default as colour } from 'picocolors';
export { default as formatBytes } from 'pretty-bytes';
