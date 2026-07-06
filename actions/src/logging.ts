import process from 'node:process';
import { inspect } from 'node:util';

import { type LogRecord, type Sink } from '@cupboard/logger';

import * as annotations from './annotations.ts';

// A field value as a string: strings verbatim, everything else through Node's
// inspector so an object never stringifies to `[object Object]`.
function stringifyValue(value: unknown): string {
	return typeof value === 'string' ? value : inspect(value);
}

// The record's message flattened to a string; with method-call syntax and no
// placeholders this is the constant message verbatim.
function messageOf(record: LogRecord): string {
	return record.message.map((part) => stringifyValue(part)).join('');
}

// Appends the record's fields to the line as space-separated `key=value` pairs.
// An `error` field is expanded to its name, message and stack so the failure is
// legible in the log; other undefined fields are skipped.
function formatFields(properties: Record<string, unknown>): string {
	const parts: string[] = [];

	for (const [key, value] of Object.entries(properties)) {
		if (value === undefined) {
			continue;
		}

		if (key === 'error') {
			if (value instanceof Error) {
				parts.push(`errorName=${value.name}`, `errorMessage=${value.message}`);

				if (value.stack !== undefined) {
					parts.push(`\n${value.stack}`);
				}

				continue;
			}

			parts.push(`errorMessage=${stringifyValue(value)}`);
			continue;
		}

		parts.push(`${key}=${stringifyValue(value)}`);
	}

	return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

/**
 * A sink that emits records as GitHub Actions workflow commands, the structured
 * log format a run understands: warnings and errors become annotations, debug
 * and trace become `::debug::` (shown only when step debugging is on), and info
 * prints as an ordinary log line. This is the action's counterpart to the
 * Workers `cloudflareSink` and the CLI's Clack sink.
 */
function emitToActions(record: LogRecord): void {
	const line = `${messageOf(record)}${formatFields(record.properties)}`;

	switch (record.level) {
		case 'trace':
		case 'debug': {
			annotations.debug(line);
			return;
		}
		case 'info': {
			process.stdout.write(`${line}\n`);
			return;
		}
		case 'warning': {
			annotations.warning(line);
			return;
		}
		case 'error':
		case 'fatal': {
			annotations.error(line);
			return;
		}
	}
}

export function githubActionsSink(): Sink {
	return emitToActions;
}
