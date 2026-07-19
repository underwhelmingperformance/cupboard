import { spawn } from 'node:child_process';
import process from 'node:process';

import { workflowCommands } from '@cupboard/shared/github-actions';

import { CommandFailedError, CupboardReportedError } from './errors.ts';

const githubActions = workflowCommands();

interface ReporterEvent {
	readonly event: string;
	readonly name?: string;
	readonly message?: string;
	readonly label?: string;
	readonly value?: string;
}

/**
 * Run the cupboard binary, forwarding its output, and turn the line-delimited
 * events it prints on stderr into GitHub annotations: every `warn` becomes a
 * warning, and a failure rejects with the `error` event the binary reported, so
 * the entry point annotates the cause the binary named.
 */
export function runCupboard(
	binaryPath: string,
	arguments_: readonly string[]
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(binaryPath, [...arguments_], {
			stdio: ['inherit', 'inherit', 'pipe']
		});
		const events = new CupboardEventStream((message) => {
			githubActions.warning(message);
		});

		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			process.stderr.write(chunk);
			events.push(chunk);
		});

		child.once('error', (error) => {
			reject(new CommandFailedError(binaryPath, child.exitCode, error.message));
		});

		child.once('close', (code) => {
			events.flush();

			if (code === 0) {
				resolve();
				return;
			}

			const failure = events.lastError();

			reject(
				failure === undefined
					? new CommandFailedError(binaryPath, code)
					: new CupboardReportedError(failure, code)
			);
		});
	});
}

/**
 * Parses the cupboard reporter's line-delimited JSON: emits a warning for each
 * `warn` event and remembers the last `error` event's message.
 */
export class CupboardEventStream {
	private buffer = '';
	private lastErrorMessage: string | undefined;

	constructor(private readonly onWarning: (message: string) => void) {}

	private handleLine(line: string): void {
		const event = parseEvent(line);

		if (event === undefined) {
			return;
		}

		if (event.event === 'error') {
			this.lastErrorMessage = errorMessage(event);
			return;
		}

		if (event.event === 'warn') {
			this.onWarning(warningMessage(event));
		}
	}

	push(chunk: string): void {
		this.buffer += chunk;

		let newline = this.buffer.indexOf('\n');

		while (newline !== -1) {
			this.handleLine(this.buffer.slice(0, newline));
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf('\n');
		}
	}

	flush(): void {
		if (this.buffer === '') {
			return;
		}

		this.handleLine(this.buffer);
		this.buffer = '';
	}

	lastError(): string | undefined {
		return this.lastErrorMessage;
	}
}

function errorMessage(event: ReporterEvent): string {
	return event.message ?? event.name ?? 'cupboard reported a failure';
}

function warningMessage(event: ReporterEvent): string {
	const label = event.label ?? event.message ?? 'cupboard reported a warning';

	return event.value === undefined ? label : `${label}: ${event.value}`;
}

function parseEvent(line: string): ReporterEvent | undefined {
	const trimmed = line.trim();

	if (!trimmed.startsWith('{')) {
		return undefined;
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}

	if (!isRecord(parsed) || typeof parsed.event !== 'string') {
		return undefined;
	}

	return {
		event: parsed.event,
		...(typeof parsed.name === 'string' && { name: parsed.name }),
		...(typeof parsed.message === 'string' && { message: parsed.message }),
		...(typeof parsed.label === 'string' && { label: parsed.label }),
		...(typeof parsed.value === 'string' && { value: parsed.value })
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
