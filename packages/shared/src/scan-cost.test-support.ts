import { check } from 'recheck';
import { vi } from 'vitest';

/**
Runs `run` and returns the number of characters that it reads through
`String.prototype.charAt` and `String.prototype.indexOf`. A call to `charAt`
reads one character. A call to `indexOf` reads the characters from its start
index to the end of its match, or to the end of the text when it finds no
match. A test can compare the result with the length of the text to show that
a scan reads each character a bounded number of times.
*/
export function charactersRead(run: () => void): number {
	const charAt = vi.spyOn(String.prototype, 'charAt');
	const indexOf = vi.spyOn(String.prototype, 'indexOf');

	try {
		run();

		let reads = charAt.mock.calls.length;

		for (const [call, [search, from = 0]] of indexOf.mock.calls.entries()) {
			const result = indexOf.mock.results[call];
			const text = indexOf.mock.contexts[call];

			if (typeof text !== 'string' || result?.type !== 'return') {
				throw new TypeError('A call to indexOf has no string or no result');
			}

			// `indexOf` clamps its start index to the text.
			const start = Math.min(Math.max(Math.trunc(from) || 0, 0), text.length);
			const end =
				result.value === -1 ? text.length : result.value + search.length;

			reads += end - start;
		}

		return reads;
	} finally {
		charAt.mockRestore();
		indexOf.mockRestore();
	}
}

export interface RegularExpressionVerdict {
	readonly pattern: string;
	readonly verdict: string;
}

/**
Runs `run` and returns a verdict for each regular expression that it executes
and that recheck does not prove safe. A test that expects an empty result fails
when the code under test executes an expression with polynomial or exponential
backtracking, for any input. The check analyses the expression, so it does not
depend on how long a matching call takes.
*/
export async function unsafeRegularExpressions(
	run: () => void
): Promise<readonly RegularExpressionVerdict[]> {
	const spy = vi.spyOn(RegExp.prototype, 'exec');
	const executed = new Map<string, RegExp>();

	try {
		run();

		for (const expression of spy.mock.contexts) {
			if (expression instanceof RegExp) {
				executed.set(`/${expression.source}/${expression.flags}`, expression);
			}
		}
	} finally {
		spy.mockRestore();
	}

	const verdicts: RegularExpressionVerdict[] = [];

	for (const [pattern, expression] of executed) {
		// An infinite time limit never expires, so the analysis finishes however
		// long it takes on a loaded machine.
		const diagnostics = await check(expression.source, expression.flags, {
			checker: 'automaton',
			timeout: Infinity,
			attackTimeout: Infinity,
			incubationTimeout: Infinity,
			seedingTimeout: Infinity
		});

		if (diagnostics.status === 'safe') {
			continue;
		}

		verdicts.push({
			pattern,
			verdict:
				diagnostics.status === 'vulnerable'
					? diagnostics.complexity.summary
					: diagnostics.status
		});
	}

	return verdicts;
}
