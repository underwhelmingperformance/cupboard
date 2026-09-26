/**
 * `true` or `false` when the result of a job condition follows from the event
 * name. For `pull_request`, the result can also use the source of the modelled
 * pull request. Otherwise `undefined`.
 */
export type ConditionOutcome = boolean | undefined;

/**
 * Where a modelled pull request comes from: a branch of the repository itself
 * or a fork.
 */
export type PullRequestSource = 'repository' | 'fork';

type Token =
	| { readonly kind: 'operator'; readonly value: string }
	| { readonly kind: 'string'; readonly value: string }
	| { readonly kind: 'word'; readonly value: string };

type Expression =
	| { readonly kind: 'or' | 'and'; readonly terms: readonly Expression[] }
	| { readonly kind: 'not'; readonly term: Expression }
	| {
			readonly kind: 'compare';
			readonly operator: string;
			readonly left: Expression;
			readonly right: Expression;
	  }
	| { readonly kind: 'event' }
	| { readonly kind: 'head-repository'; readonly field: RepositoryField }
	| { readonly kind: 'repository'; readonly field: RepositoryField }
	| { readonly kind: 'string'; readonly value: string }
	| { readonly kind: 'boolean'; readonly value: boolean }
	| { readonly kind: 'unknown' };

type RepositoryField = 'id' | 'name';

// The two forms of the guard that limits a job to pull requests from the
// repository itself: the head repository compared with the base repository by
// numeric ID or by full name.
const repositoryContexts: ReadonlyMap<
	string,
	{
		readonly kind: 'head-repository' | 'repository';
		readonly field: RepositoryField;
	}
> = new Map([
	[
		'github.event.pull_request.head.repo.id',
		{ kind: 'head-repository', field: 'id' }
	],
	[
		'github.event.pull_request.head.repo.full_name',
		{ kind: 'head-repository', field: 'name' }
	],
	['github.repository_id', { kind: 'repository', field: 'id' }],
	['github.repository', { kind: 'repository', field: 'name' }]
]);

// A job-level condition determines whether the job starts. `success()` and
// `always()` are true at that point for a job without failed dependencies.
const runningStatusFunctions = new Set(['success', 'always']);

class ConditionSyntaxError extends Error {
	constructor() {
		super('unsupported job condition syntax');
		this.name = 'ConditionSyntaxError';
	}
}

const operators = [
	'&&',
	'||',
	'==',
	'!=',
	'<=',
	'>=',
	'!',
	'<',
	'>',
	'(',
	')',
	'[',
	']',
	','
];
const comparisonOperators = new Set(['==', '!=', '<', '<=', '>', '>=']);
const whitespace = /^\s+/u;
const quotedString = /^'((?:[^']|'')*)'/u;
const bareWord = /^[\w.*-]+/u;
const expressionWrapper = /^\s*\$\{\{(.*)\}\}\s*$/su;

function tokens(source: string): Token[] {
	const result: Token[] = [];
	let index = 0;

	while (index < source.length) {
		const rest = source.slice(index);
		const space = whitespace.exec(rest);

		if (space !== null) {
			index += space[0].length;
			continue;
		}

		const quoted = quotedString.exec(rest);

		if (quoted !== null) {
			result.push({
				kind: 'string',
				value: (quoted[1] ?? '').replaceAll("''", "'")
			});
			index += quoted[0].length;
			continue;
		}

		const operator = operators.find((candidate) => rest.startsWith(candidate));

		if (operator !== undefined) {
			result.push({ kind: 'operator', value: operator });
			index += operator.length;
			continue;
		}

		const word = bareWord.exec(rest);

		if (word === null) {
			throw new ConditionSyntaxError();
		}

		result.push({ kind: 'word', value: word[0] });
		index += word[0].length;
	}

	return result;
}

class Parser {
	private position = 0;

	constructor(private readonly input: readonly Token[]) {}

	private peek(): Token | undefined {
		return this.input[this.position];
	}

	private accept(operator: string): boolean {
		const token = this.peek();

		if (token?.kind !== 'operator' || token.value !== operator) {
			return false;
		}

		this.position += 1;
		return true;
	}

	private expect(operator: string): void {
		if (!this.accept(operator)) {
			throw new ConditionSyntaxError();
		}
	}

	private or(): Expression {
		const terms = [this.and()];

		while (this.accept('||')) {
			terms.push(this.and());
		}

		const [first] = terms;

		return first !== undefined && terms.length === 1
			? first
			: { kind: 'or', terms };
	}

	private and(): Expression {
		const terms = [this.comparison()];

		while (this.accept('&&')) {
			terms.push(this.comparison());
		}

		const [first] = terms;

		return first !== undefined && terms.length === 1
			? first
			: { kind: 'and', terms };
	}

	// GitHub binds `!` more tightly than `==` and `!=`, so `!a == b` compares
	// `!a` with `b`.
	private unary(): Expression {
		if (this.accept('!')) {
			return { kind: 'not', term: this.unary() };
		}

		return this.primary();
	}

	private comparison(): Expression {
		const left = this.unary();
		const token = this.peek();

		if (token?.kind !== 'operator' || !comparisonOperators.has(token.value)) {
			return left;
		}

		this.position += 1;

		return {
			kind: 'compare',
			operator: token.value,
			left,
			right: this.unary()
		};
	}

	private primary(): Expression {
		if (this.accept('(')) {
			const expression = this.or();

			this.expect(')');
			return expression;
		}

		const token = this.peek();

		if (token === undefined || token.kind === 'operator') {
			throw new ConditionSyntaxError();
		}

		this.position += 1;

		if (token.kind === 'string') {
			return { kind: 'string', value: token.value };
		}

		if (this.accept('(')) {
			const hasArguments = this.functionArguments();

			return !hasArguments &&
				runningStatusFunctions.has(token.value.toLowerCase())
				? { kind: 'boolean', value: true }
				: { kind: 'unknown' };
		}

		let isIndexed = false;

		while (this.accept('[')) {
			this.or();
			this.expect(']');
			isIndexed = true;
		}

		const name = token.value.toLowerCase();
		const repositoryContext = repositoryContexts.get(name);

		if (!isIndexed && name === 'github.event_name') {
			return { kind: 'event' };
		}

		if (!isIndexed && repositoryContext !== undefined) {
			return repositoryContext;
		}

		if (token.value === 'true' || token.value === 'false') {
			return { kind: 'boolean', value: token.value === 'true' };
		}

		return { kind: 'unknown' };
	}

	private expectEnd(): void {
		if (this.position !== this.input.length) {
			throw new ConditionSyntaxError();
		}
	}

	private functionArguments(): boolean {
		if (this.accept(')')) {
			return false;
		}

		do {
			this.or();
		} while (this.accept(','));

		this.expect(')');
		return true;
	}

	parse(): Expression {
		const expression = this.or();

		this.expectEnd();
		return expression;
	}
}

function isSameRepositoryGuard(
	expression: Extract<Expression, { kind: 'compare' }>
): boolean {
	const { left, right } = expression;
	const [head, base] =
		left.kind === 'head-repository' ? [left, right] : [right, left];

	return (
		head.kind === 'head-repository' &&
		base.kind === 'repository' &&
		head.field === base.field
	);
}

function compareEvent(
	expression: Extract<Expression, { kind: 'compare' }>,
	event: string,
	source: PullRequestSource
): ConditionOutcome {
	const { left, right, operator } = expression;

	if (operator !== '==' && operator !== '!=') {
		return undefined;
	}

	// For any event other than a pull request, the pull request context is
	// empty and differs from the repository.
	if (isSameRepositoryGuard(expression)) {
		const isSame = event === 'pull_request' && source === 'repository';

		return operator === '==' ? isSame : !isSame;
	}

	const literal =
		left.kind === 'event' && right.kind === 'string'
			? right.value
			: right.kind === 'event' && left.kind === 'string'
				? left.value
				: undefined;

	if (literal === undefined) {
		return undefined;
	}

	// GitHub compares strings without regard to case.
	const isEqual = literal.toLowerCase() === event.toLowerCase();

	return operator === '==' ? isEqual : !isEqual;
}

function evaluate(
	expression: Expression,
	event: string,
	source: PullRequestSource
): ConditionOutcome {
	switch (expression.kind) {
		case 'or': {
			const outcomes = expression.terms.map((term) =>
				evaluate(term, event, source)
			);

			if (outcomes.includes(true)) {
				return true;
			}

			if (outcomes.every((outcome) => outcome === false)) {
				return false;
			}

			return undefined;
		}
		case 'and': {
			const outcomes = expression.terms.map((term) =>
				evaluate(term, event, source)
			);

			if (outcomes.includes(false)) {
				return false;
			}

			if (outcomes.every((outcome) => outcome === true)) {
				return true;
			}

			return undefined;
		}
		case 'not': {
			const outcome = evaluate(expression.term, event, source);

			return outcome === undefined ? undefined : !outcome;
		}
		case 'compare': {
			return compareEvent(expression, event, source);
		}
		case 'event': {
			return event !== '';
		}
		case 'string': {
			return expression.value !== '';
		}
		case 'boolean': {
			return expression.value;
		}
		case 'head-repository':
		case 'repository':
		case 'unknown': {
			return undefined;
		}
	}
}

function parseCondition(condition: string): Expression | undefined {
	const source = expressionWrapper.exec(condition)?.[1] ?? condition;

	if (source.includes('${{')) {
		return undefined;
	}

	try {
		return new Parser(tokens(source)).parse();
	} catch (error) {
		if (error instanceof ConditionSyntaxError) {
			return undefined;
		}

		throw error;
	}
}

/**
 * Evaluates whether a job's `if` value allows the job to run for one event.
 * The evaluator handles comparisons of `github.event_name` with a string
 * literal, the guard that compares a pull request's head repository with the
 * repository, and the status functions `success()` and `always()`, combined
 * with `&&`, `||`, `!` and parentheses. It treats every other term as unknown.
 * An `if` value may be written with or without the `${{ }}` wrapper, because
 * GitHub accepts both. For `pull_request`, the guard is true when `source` is
 * `repository` and false when it is `fork`.
 */
export function jobConditionOutcome(
	condition: string | boolean,
	event: string,
	source: PullRequestSource = 'repository'
): ConditionOutcome {
	if (typeof condition === 'boolean') {
		return condition;
	}

	const expression = parseCondition(condition);

	return expression === undefined
		? undefined
		: evaluate(expression, event, source);
}
