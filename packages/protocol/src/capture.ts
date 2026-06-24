import { RE2JS } from 're2js';

import { type Substitution } from './grants.ts';

// Capture patterns come from admin-authored trust rules, so they are evaluated
// with RE2 (linear time, no catastrophic backtracking) and never JavaScript
// `RegExp`. RE2 also rejects backreferences and lookaround at compile, so an
// unsupported feature fails closed here rather than at match time.

export class InvalidCapturePatternError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidCapturePatternError';
	}
}

export class SubstitutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SubstitutionError';
	}
}

/**
 * Compile an anchored RE2 pattern. Throws {@link InvalidCapturePatternError} for
 * an unanchored pattern or one RE2 cannot compile. RE2's `matches` requires the
 * whole input to match; the `^`/`$` anchors are mandatory for clarity.
 */
export function compilePattern(pattern: string): RE2JS {
	if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
		throw new InvalidCapturePatternError(
			'pattern must be anchored with ^ and $'
		);
	}

	try {
		return RE2JS.compile(pattern);
	} catch (error) {
		throw new InvalidCapturePatternError(
			`pattern is not a valid RE2 expression: ${String(error)}`
		);
	}
}

/** Whether a pattern is an anchored expression RE2 can compile. */
export function isAnchoredRe2(pattern: string): boolean {
	try {
		compilePattern(pattern);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether `value` matches the anchored pattern in full. Fails closed: a pattern
 * that does not compile yields `false` rather than throwing, so claim matching
 * never faults a token exchange.
 */
export function isPatternMatch(pattern: string, value: string): boolean {
	try {
		return compilePattern(pattern).matcher(value).matches();
	} catch {
		return false;
	}
}

/**
 * Compile a capture pattern, requiring it to be anchored and to define at least
 * one named group (each named group becomes a template variable). Throws
 * {@link InvalidCapturePatternError} for an unanchored pattern, a pattern RE2
 * cannot compile, or one with no named group.
 */
export function compileCapture(pattern: string): RE2JS {
	const compiled = compilePattern(pattern);

	if (Object.keys(compiled.namedGroups()).length === 0) {
		throw new InvalidCapturePatternError(
			'capture pattern must define at least one named group'
		);
	}

	return compiled;
}

/** The named groups a capture pattern defines. */
export function captureGroups(pattern: string): string[] {
	return Object.keys(compileCapture(pattern).namedGroups());
}

/** Quote text for literal interpolation into an RE2 pattern. */
export function quotePatternLiteral(value: string): string {
	return RE2JS.quote(value);
}

/**
 * Resolve a substitution to a concrete string from the verified claims. Throws
 * {@link SubstitutionError} when the claim is absent or a capture does not match.
 */
export function applyTransform(
	substitution: Substitution,
	claims: Readonly<Record<string, string>>
): string {
	const value = claims[substitution.claim];

	if (value === undefined) {
		throw new SubstitutionError(`claim ${substitution.claim} is absent`);
	}

	if (substitution.capture !== undefined) {
		return applyCapture(substitution.capture, value, substitution.claim);
	}

	if (substitution.slug === true) {
		return slug(value);
	}

	return value;
}

function applyCapture(
	capture: { readonly pattern: string; readonly group: string },
	value: string,
	claim: string
): string {
	const matcher = compileCapture(capture.pattern).matcher(value);

	if (!matcher.matches()) {
		throw new SubstitutionError(
			`claim ${claim} did not match the capture pattern`
		);
	}

	let group: string | null;

	try {
		group = matcher.group(capture.group);
	} catch (error) {
		throw new InvalidCapturePatternError(
			`capture group ${capture.group} is not defined: ${String(error)}`
		);
	}

	if (group === null) {
		throw new SubstitutionError(
			`capture group ${capture.group} did not participate in the match`
		);
	}

	return group;
}

// Lower-case and collapse runs of characters outside the cache/root grammar to a
// single hyphen. The rendered value is re-validated against its destination
// grammar by the caller, so an empty or boundary-breaking result fails closed.
function slug(value: string): string {
	return value.toLowerCase().replaceAll(/[^a-z0-9._-]+/gu, '-');
}
