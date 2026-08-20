import process from 'node:process';

import {
	type WorkflowCommands,
	workflowCommands,
	type WorkflowCommandStreams
} from '@cupboard/shared/github-actions';
import { type LogRecord, type Sink } from '@logtape/logtape';

// The console method each LogTape level maps to. Workers Logs and a terminal
// both separate warnings and errors from ordinary output this way.
function consoleMethodFor(
	level: LogRecord['level']
): 'debug' | 'info' | 'warn' | 'error' {
	switch (level) {
		case 'trace':
		case 'debug': {
			return 'debug';
		}
		case 'info': {
			return 'info';
		}
		case 'warning': {
			return 'warn';
		}
		case 'error':
		case 'fatal': {
			return 'error';
		}
	}
}

// Returns the record's message as a string. Method-call syntax without
// placeholders already produces a constant string. This also joins interleaved
// message parts.
function messageOf(record: LogRecord): string {
	return record.message
		.map((part) => (typeof part === 'string' ? part : String(part)))
		.join('');
}

// A value rendered for the log without risking a `[object Object]`.
function renderValue(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}

	if (
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		typeof value === 'bigint'
	) {
		return String(value);
	}

	if (typeof value === 'object' && value !== null) {
		try {
			return JSON.stringify(value);
		} catch {
			return Object.prototype.toString.call(value);
		}
	}

	return Object.prototype.toString.call(value);
}

// Follows an error's `cause` chain and returns the underlying messages. Drizzle,
// for example, wraps a D1 error in `Failed query: …` and stores the original
// error in `cause`. Without this traversal, the log would contain only the
// wrapper. The traversal stops after eight causes or when it detects a cycle.
function causeChain(
	error: Error
): { readonly message: string; readonly stack?: string } | undefined {
	const messages: string[] = [];
	const seen = new Set<unknown>([error]);
	let current: unknown = error.cause;
	let root: Error | undefined;

	while (current !== undefined && !seen.has(current) && messages.length < 8) {
		seen.add(current);

		if (current instanceof Error) {
			messages.push(`${current.name}: ${current.message}`);
			root = current;
			current = current.cause;
			continue;
		}

		messages.push(renderValue(current));
		current = undefined;
	}

	if (messages.length === 0) {
		return undefined;
	}

	return {
		message: messages.join(' <- '),
		...(root?.stack !== undefined && { stack: root.stack })
	};
}

// Expands an `error` field into indexed fields for the error name, message,
// stack, and cause. Workers Logs can then query each field separately.
function expandError(
	properties: Record<string, unknown>
): Record<string, unknown> {
	if (!('error' in properties)) {
		return properties;
	}

	const { error, ...rest } = properties;

	if (error instanceof Error) {
		const cause = causeChain(error);

		return {
			...rest,
			errorName: error.name,
			errorMessage: error.message,
			...(error.stack !== undefined && { errorStack: error.stack }),
			...(cause !== undefined && {
				errorCause: cause.message,
				...(cause.stack !== undefined && { errorCauseStack: cause.stack })
			})
		};
	}

	return { ...rest, errorMessage: String(error) };
}

function logObject(record: LogRecord): Record<string, unknown> {
	return {
		level: record.level,
		category: record.category.join('.'),
		msg: messageOf(record),
		...expandError(record.properties)
	};
}

/**
The slice of `console` the Workers sink calls, injectable for tests.
*/
export interface ConsoleLike {
	debug(payload: unknown): void;
	info(payload: unknown): void;
	warn(payload: unknown): void;
	error(payload: unknown): void;
}

/**
 * Writes each record to the console as a plain object, which lets Cloudflare
 * Workers Logs index every field. The constant message uses the `msg` field,
 * and the remaining fields contain variable data. Tests can inject a console
 * implementation.
 */
export function cloudflareSink(target: ConsoleLike = console): Sink {
	return (record) => {
		target[consoleMethodFor(record.level)](logObject(record));
	};
}

/**
 * Writes one JSON object per line through `write` for the CLI's machine-readable
 * mode. The caller usually supplies stderr. Accepting a writer keeps this module
 * free of Node imports, so the Worker can bundle it with
 * {@link cloudflareSink}.
 */
export function jsonLinesSink(write: (line: string) => void): Sink {
	return (record) => {
		write(
			`${JSON.stringify({ timestamp: record.timestamp, ...logObject(record) })}\n`
		);
	};
}

// The record's properties as space-separated `key=value` pairs, so the
// structured context stays legible in a GitHub Actions log line. An `error`
// property is first expanded into its name, message, stack and cause (see
// {@link expandError}).
function actionFields(properties: Record<string, unknown>): string {
	const parts: string[] = [];
	const fields = expandError(properties);

	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) {
			continue;
		}

		parts.push(`${key}=${renderValue(value)}`);
	}

	return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

function emitToActions(
	commands: WorkflowCommands,
	out: { write(chunk: string): unknown },
	record: LogRecord
): void {
	const line = `${messageOf(record)}${actionFields(record.properties)}`;

	switch (record.level) {
		case 'trace':
		case 'debug': {
			commands.debug(line);
			return;
		}
		case 'info': {
			out.write(`${line}\n`);
			return;
		}
		case 'warning': {
			commands.warning(line);
			return;
		}
		case 'error':
		case 'fatal': {
			commands.error(line);
			return;
		}
	}
}

/**
 * Emits records as GitHub Actions workflow commands. Warnings and errors become
 * annotations. Trace and debug records use `::debug::` and appear only when step
 * debugging is enabled. Informational records use ordinary log lines.
 */
export function githubActionsSink(streams: WorkflowCommandStreams = {}): Sink {
	const commands = workflowCommands(streams);
	const out = streams.stdout ?? process.stdout;

	return (record) => {
		emitToActions(commands, out, record);
	};
}
