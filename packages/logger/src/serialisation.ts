import { configure } from 'safe-stable-stringify';

import { prioritiseProperties, redactLogProperties } from './redaction.ts';

export function renderValue(value: unknown): string {
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
	error: ErrorDetails
): { readonly message: string; readonly stack?: string } | undefined {
	const messages: string[] = [];
	const seen = new Set<unknown>([error]);
	let current: unknown = error.cause;
	let root: ErrorDetails | undefined;

	while (current !== undefined && !seen.has(current) && messages.length < 8) {
		seen.add(current);

		if (isErrorDetails(current)) {
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
		...(typeof root?.stack === 'string' && { stack: root.stack })
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

	if (isErrorDetails(error)) {
		const cause = causeChain(error);

		return {
			...rest,
			errorDetails: error,
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

const stringify = configure({
	maximumDepth: 8,
	maximumBreadth: 64,
	deterministic: false,
	circularValue: '[Circular]'
});

interface ErrorDetails extends Record<string, unknown> {
	readonly name: string;
	readonly message: string;
}

function isErrorDetails(value: unknown): value is ErrorDetails {
	return (
		typeof value === 'object' &&
		value !== null &&
		'message' in value &&
		typeof value.message === 'string' &&
		'name' in value &&
		typeof value.name === 'string'
	);
}

function projectError(
	error: Error,
	projections: WeakMap<Error, Record<string, unknown>>
): Record<string, unknown> {
	const existing = projections.get(error);

	if (existing !== undefined) {
		return existing;
	}

	const result: Record<string, unknown> = {
		name: error.name,
		message: error.message,
		stack: error.stack,
		cause: error.cause,
		...(error instanceof AggregateError && { errors: error.errors })
	};
	projections.set(error, result);

	const diagnosticKeys = [
		'code',
		'errno',
		'syscall',
		'address',
		'port',
		'hostname',
		'localAddress',
		'localPort',
		'remoteAddress',
		'remotePort'
	];
	const keys = [
		...new Set([
			...diagnosticKeys.filter((key) => Reflect.has(error, key)),
			...Object.keys(error)
		])
	].slice(0, 64 - Object.keys(result).length);

	for (const key of keys) {
		if (!Object.hasOwn(result, key)) {
			result[key] = Reflect.get(error, key);
		}
	}

	const redacted = redactLogProperties(result);
	projections.set(error, redacted);

	return redacted;
}

/**
Preserves nested error causes and socket details within diagnostic limits.
*/
export function serialiseLogProperties(
	properties: Record<string, unknown>
): Record<string, unknown> {
	const projections = new WeakMap<Error, Record<string, unknown>>();

	try {
		const text = stringify(
			redactLogProperties(prioritiseProperties(properties)),
			function (this: object, key, value: unknown) {
				const original: unknown = Object.getOwnPropertyDescriptor(
					this,
					key
				)?.value;

				if (original instanceof Error) {
					return projectError(original, projections);
				}

				if (typeof value === 'bigint') {
					return `${String(value)}n`;
				}

				return value instanceof Error
					? projectError(value, projections)
					: value;
			}
		);
		const parsed: unknown = JSON.parse(text ?? '{}');

		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return { logSerialisationFailed: true };
		}

		return expandError(Object.fromEntries(Object.entries(parsed)));
	} catch {
		return { logSerialisationFailed: true };
	}
}
