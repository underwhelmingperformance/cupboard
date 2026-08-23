/**
 * Process exit codes by failure category, so a caller can tell a misuse from
 * the catch-all. 2 is the usual shell convention for a usage error and 1 is the
 * catch-all; packages layer their own categories (for example the BSD sysexits
 * codes) on top.
 */
export const genericExitCode = 1;
export const usageExitCode = 2;

export abstract class CodedError extends Error {
	get exitCode(): number {
		return genericExitCode;
	}
}

export abstract class UsageError extends CodedError {
	override get exitCode(): number {
		return usageExitCode;
	}
}

const maxRenderedCauses = 5;

/**
 * Returns descriptions of up to five causes, starting with the nearest cause.
 * Errors use `name: message`, objects use JSON, and other values use their
 * string form. The walk stops when it reaches a repeated object, so a cyclic
 * cause chain terminates.
 */
export function errorCauses(error: unknown): string[] {
	const described: string[] = [];
	const seen = new Set<object>();
	let current = error;

	while (described.length < maxRenderedCauses) {
		if (typeof current !== 'object' || current === null) {
			return described;
		}

		seen.add(current);

		const cause: unknown = 'cause' in current ? current.cause : undefined;

		if (cause === undefined || cause === null) {
			return described;
		}

		if (typeof cause === 'object' && seen.has(cause)) {
			return described;
		}

		described.push(describeCause(cause));
		current = cause;
	}

	return described;
}

function describeCause(cause: unknown): string {
	if (cause instanceof Error) {
		return `${cause.name}: ${cause.message}`;
	}

	if (typeof cause === 'object' && cause !== null) {
		return describeObject(cause);
	}

	return String(cause);
}

// Use JSON so a plain object's fields appear in the diagnostic. Fall back to
// the object's tag when JSON cannot represent the value.
function describeObject(cause: object): string {
	try {
		return serialise(cause) ?? Object.prototype.toString.call(cause);
	} catch {
		return Object.prototype.toString.call(cause);
	}
}

// `JSON.stringify` can return undefined through `toJSON`, despite its declared
// return type. Expose that possibility to the caller.
function serialise(value: object): string | undefined {
	return JSON.stringify(value);
}

/**
 * A thrown value's own message with its `cause` chain below it, one indented
 * line per level. Use this in a diagnostic instead of `error.message`: several
 * errors report only that an operation failed and keep the reason in `cause`.
 */
export function formatErrorWithCauses(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);

	return [message, ...errorCauses(error).map((cause) => `  ${cause}`)].join(
		'\n'
	);
}
