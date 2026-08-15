/**
 * Process exit codes by failure category, so a caller can tell a misuse from
 * the catch-all. 2 is the usual shell convention for a usage error and 1 is the
 * catch-all; packages layer their own categories (for example the BSD sysexits
 * codes) on top.
 */
export const genericExitCode = 1;
export const usageExitCode = 2;

/** An error that carries the process exit code its failure should produce. */
export abstract class CodedError extends Error {
	get exitCode(): number {
		return genericExitCode;
	}
}

/** A misuse: a bad argument value or an unsupported combination of them. */
export abstract class UsageError extends CodedError {
	override get exitCode(): number {
		return usageExitCode;
	}
}

/** How many levels of a `cause` chain a diagnostic shows. */
const maxRenderedCauses = 5;

/**
 * The `cause` chain behind a thrown value, nearest cause first. An `Error` is
 * described as `name: message`, an object as JSON, and any other value by its
 * string form. Returns an empty array for a value without a cause.
 *
 * The walk stops after {@link maxRenderedCauses} levels, and at any value
 * already described, so a chain that refers back to an earlier error does not
 * loop forever.
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

// An object cause as JSON, so its fields appear in the diagnostic. `String`
// gives `[object Object]` for an object that does not define its own
// `toString`, and a cause that is not an error is usually a plain object.
// `JSON.stringify` throws on a structure it cannot represent, such as a
// circular one or one holding a BigInt, so those fall back to the object's tag.
function describeObject(cause: object): string {
	try {
		return serialise(cause) ?? Object.prototype.toString.call(cause);
	} catch {
		return Object.prototype.toString.call(cause);
	}
}

// `JSON.stringify` returns undefined when the value's `toJSON` returns
// undefined, but its declared return type is plain `string`. Keep that
// possibility in this wrapper's type so the caller has to handle it.
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
