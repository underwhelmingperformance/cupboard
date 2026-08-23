import { log } from '@clack/prompts';
import type { LogLevel, LogRecord, Sink } from '@cupboard/logger';
import pc from 'picocolors';

type Colours = ReturnType<typeof pc.createColors>;

type ClackMethod = 'error' | 'info' | 'message' | 'warn';

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

function messageOf(record: LogRecord): string {
	return record.message.map(String).join('');
}

function renderProperty(key: string, value: unknown): string {
	if (key === 'error' && value instanceof Error) {
		return `${key} ${value.name}: ${value.message}`;
	}

	return `${key} ${String(value)}`;
}

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
 * Renders LogTape records through Clack. Record properties form a dimmed,
 * single-line suffix; an Error property uses its name and message. Warning and
 * error levels retain their distinct Clack channels, while trace and debug use
 * the neutral message channel.
 */
export function clackSink(colours: Colours): Sink {
	return (record) => {
		const line = `${messageOf(record)}${renderFields(record.properties, colours)}`;
		log[methodFor(record.level)](line);
	};
}
