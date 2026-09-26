import {
	isPatternMatch,
	quotePatternLiteral
} from '@cupboard/protocol/capture';

// GitHub filter patterns also accept `?`, `+`, character ranges and `!`
// negation. The check evaluates only literal names with `*` and `**`, and
// reports any other pattern for manual review.
const supportedPattern = /^(?:[A-Za-z0-9._/-]|\*)+$/u;

/**
 * A branch or tag pattern from a workflow's `on.<event>` filters. A `*`
 * matches within one path segment, and `**` matches across segments.
 */
export class ReferencePattern {
	static parse(glob: string): ReferencePattern | undefined {
		return supportedPattern.test(glob) ? new ReferencePattern(glob) : undefined;
	}

	private constructor(public readonly glob: string) {}

	private expression(): string {
		return this.glob
			.split('**')
			.map((part) =>
				part
					.split('*')
					.map((literal) => quotePatternLiteral(literal))
					.join('[^/]*')
			)
			.join('.*');
	}

	matches(name: string): boolean {
		return isPatternMatch(`^${this.expression()}$`, name);
	}

	/**
	 * A name that the pattern matches, for building modelled claims.
	 */
	example(): string {
		return this.glob.replaceAll('*', '0');
	}
}
