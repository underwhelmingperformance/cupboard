import { stderr } from 'node:process';

import ora from 'ora';
import pc from 'picocolors';

/** Terminal (spinner) or line-delimited JSON output. */
export type ReporterMode = 'terminal' | 'json';

export interface PhaseContext {
	fact(label: string, value: string | number): void;
}

/**
 * The slice of a progress reporter the commit-message linter needs: a single
 * `phase` that wraps a unit of work, shown as a spinner with live facts in
 * terminal mode and one `{event:'phase'}` line in JSON mode. The linter never
 * renders result tables, so there is no `result`/`data` surface here.
 */
export interface Reporter {
	phase<T>(
		label: string,
		body: (context: PhaseContext) => Promise<T> | T
	): Promise<T>;
}

export interface ReporterOptions {
	readonly mode: ReporterMode;
	readonly stream?: NodeJS.WritableStream;
}

export function createReporter(options: ReporterOptions): Reporter {
	const stream = options.stream ?? stderr;

	return options.mode === 'terminal'
		? createTerminalReporter(stream)
		: createJsonReporter(stream);
}

function createTerminalReporter(stream: NodeJS.WritableStream): Reporter {
	return {
		async phase(label, body) {
			const facts: { label: string; value: string }[] = [];
			const spinner = ora({ text: label, stream }).start();

			const render = (): void => {
				spinner.text =
					facts.length === 0 ? label : `${label} · ${formatFacts(facts)}`;
			};

			const startedAt = Date.now();

			try {
				const value = await body({
					fact(factLabel, factValue) {
						facts.push({ label: factLabel, value: String(factValue) });
						render();
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
		}
	};
}

function createJsonReporter(stream: NodeJS.WritableStream): Reporter {
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

				stream.write(
					`${JSON.stringify({
						event: 'phase',
						label,
						status: 'ok',
						durationMs: Date.now() - startedAt,
						facts
					})}\n`
				);

				return value;
			} catch (error) {
				stream.write(
					`${JSON.stringify({
						event: 'phase',
						label,
						status: 'failed',
						durationMs: Date.now() - startedAt,
						error: error instanceof Error ? error.message : String(error)
					})}\n`
				);

				throw error;
			}
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

function formatDuration(milliseconds: number): string {
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
