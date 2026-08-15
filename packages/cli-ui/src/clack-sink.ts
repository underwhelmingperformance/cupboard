import { log } from '@clack/prompts';
import type { LogLevel, LogRecord, Sink } from '@cupboard/logger';
import pc from 'picocolors';

/** A picocolors palette with its colour enablement fixed at creation. */
type Colours = ReturnType<typeof pc.createColors>;

/** The clack `log` method a LogTape level renders through. */
type ClackMethod = 'error' | 'info' | 'message' | 'warn';

// Which clack call a level uses. Warnings and errors get their own channels;
// info narrates; trace and debug are low-priority, so they use the neutral
// `log.message` and rely on the dimmed rendering below to stay unobtrusive.
function methodFor(level: LogLevel): ClackMethod {
	switch (level) {
		case 'warning': {
			return 'warn';
		}
		case 'error':
		case 'fatal': {
			return 'error';
		}
		case 'info': {
			return 'info';
		}
		case 'trace':
		case 'debug': {
			return 'message';
		}
	}
}

// The record's message flattened to a string. With method-call syntax and no
// placeholders this is the constant message verbatim; any interleaved parts are
// joined for completeness.
function messageOf(record: LogRecord): string {
	return record.message.map(String).join('');
}

// One property rendered as `key value`. An `error` field shows the error's
// name and message, keeping the terminal line to a single readable summary.
function renderProperty(key: string, value: unknown): string {
	if (key === 'error' && value instanceof Error) {
		return `${key} ${value.name}: ${value.message}`;
	}

	return `${key} ${String(value)}`;
}

// The record's properties as a dimmed, single-line summary, rendered the same
// way as the facts on a spinner title: the variable data goes here so the
// message itself stays constant and low-cardinality. Undefined values are
// skipped.
function renderFields(
	properties: Record<string, unknown>,
	colours: Colours
): string {
	const annotations = Object.entries(properties)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => renderProperty(key, value));

	if (annotations.length === 0) {
		return '';
	}

	return ` ${colours.dim(`· ${annotations.join(' · ')}`)}`;
}

/**
 * A LogTape {@link Sink} that renders CLI diagnostics through `@clack/prompts`.
 * The constant message carries the emphasis; the record's properties trail it as
 * a dimmed field summary. Levels map to clack channels so warnings and errors
 * stay distinct from ordinary narration.
 */
export function clackSink(colours: Colours): Sink {
	return (record) => {
		const line = `${messageOf(record)}${renderFields(record.properties, colours)}`;
		log[methodFor(record.level)](line);
	};
}
