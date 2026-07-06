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

// Explodes an `error` field into indexed sub-fields, so its name, message and
// stack are each queryable in Workers Logs.
function expandError(
	properties: Record<string, unknown>
): Record<string, unknown> {
	if (!('error' in properties)) {
		return properties;
	}

	const { error, ...rest } = properties;

	if (error instanceof Error) {
		return {
			...rest,
			errorName: error.name,
			errorMessage: error.message,
			...(error.stack !== undefined && { errorStack: error.stack })
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
