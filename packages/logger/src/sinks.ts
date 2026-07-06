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

// The record's message flattened to a string. With method-call syntax and no
// placeholders this is the constant message verbatim; the interleaved form is
// joined for completeness.
function messageOf(record: LogRecord): string {
	return record.message
		.map((part) => (typeof part === 'string' ? part : String(part)))
		.join('');
}

// A non-Error cause rendered for the log without risking a `[object Object]`.
function renderCause(value: unknown): string {
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

// Walks an error's `cause` chain, so a wrapped error surfaces the underlying
// fault rather than only its wrapper. A driver such as drizzle rethrows a
// D1 failure as `Failed query: …` with the real error on `cause`, so without this
// the message that actually explains the failure never reaches the logs. Bounded
// to guard against a cyclic chain.
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

		messages.push(renderCause(current));
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

// Explodes an `error` field into indexed sub-fields, so its name, message, stack
// and underlying cause are each queryable in Workers Logs.
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

function emitToConsole(record: LogRecord): void {
	console[consoleMethodFor(record.level)](logObject(record));
}

/**
 * A sink that hands a plain object to `console`, so Cloudflare Workers Logs
 * indexes every field. The message stays a constant string under `msg`; all
 * variable data rides in the object's other keys.
 */
export function cloudflareSink(): Sink {
	return emitToConsole;
}

/**
 * A sink that writes one JSON object per line through `write`, for the CLI's
 * machine mode. The caller supplies the writer (typically stderr) so this stays
 * free of any Node import and safe to bundle in the Worker alongside
 * {@link cloudflareSink}.
 */
export function jsonLinesSink(write: (line: string) => void): Sink {
	return (record) => {
		write(
			`${JSON.stringify({ timestamp: record.timestamp, ...logObject(record) })}\n`
		);
	};
}
