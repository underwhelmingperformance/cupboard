import process from 'node:process';

import {
	type WorkflowCommands,
	workflowCommands,
	type WorkflowCommandStreams
} from '@cupboard/shared/github-actions';
import { type LogRecord, type Sink } from '@logtape/logtape';

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

function messageOf(record: LogRecord): string {
	return record.message
		.map((part) => (typeof part === 'string' ? part : String(part)))
		.join('');
}

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

// Drizzle can wrap the useful D1 message in a generic `Failed query` error.
// Follow at most eight causes so the log retains the underlying messages, and
// stop early if the chain contains a cycle.
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

// Workers Logs can index the name, message, stack and cause only when they are
// separate fields rather than properties of an Error object.
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
 * Writes one JSON object per line through the supplied callback. The caller
 * chooses the destination; the default logger and CLI normally supply stderr.
 */
export function jsonLinesSink(write: (line: string) => void): Sink {
	return (record) => {
		write(
			`${JSON.stringify({ timestamp: record.timestamp, ...logObject(record) })}\n`
		);
	};
}

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
 * When `GITHUB_ACTIONS=true`, warnings and errors become annotations and trace
 * and debug records use `::debug::`. Informational records remain plain lines.
 * Outside GitHub Actions, the shared command emitter falls back to plain lines.
 */
export function githubActionsSink(streams: WorkflowCommandStreams = {}): Sink {
	const commands = workflowCommands(streams);
	const out = streams.stdout ?? process.stdout;

	return (record) => {
		emitToActions(commands, out, record);
	};
}
