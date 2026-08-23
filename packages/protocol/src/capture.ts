import { RE2JS } from 're2js';

import { type Substitution } from './grants.ts';

// Capture patterns come from admin-authored trust rules, so they are evaluated
// with RE2 (linear time, no catastrophic backtracking) and never JavaScript
// `RegExp`. RE2 also rejects backreferences and lookaround at compile, so an
// unsupported feature fails closed at compile time.

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

export function isAnchoredRe2(pattern: string): boolean {
	try {
		compilePattern(pattern);
		return true;
	} catch {
		return false;
	}
}

/**
 * An invalid pattern returns `false` instead of faulting a token exchange. A
 * valid pattern is anchored and must match the complete value.
 */
export function isPatternMatch(pattern: string, value: string): boolean {
	try {
		return compilePattern(pattern).matcher(value).matches();
	} catch {
		return false;
	}
}

/**
 * Capture patterns must be anchored and define at least one named group. Each
 * named group becomes a template variable. This function throws
 * {@link InvalidCapturePatternError} if the pattern violates either constraint
 * or RE2 cannot compile it.
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

export function captureGroups(pattern: string): string[] {
	return Object.keys(compileCapture(pattern).namedGroups());
}

export function quotePatternLiteral(value: string): string {
	return RE2JS.quote(value);
}

/**
 * Substitutions read values from verified claims. A missing claim or a capture
 * that does not match throws {@link SubstitutionError}.
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
