/**
 * `true` or `false` when the result of a job condition follows from the event
 * name. For `pull_request`, the result can also use the source and activity of
 * the modelled pull request. Otherwise `undefined`.
 */
export type ConditionOutcome = boolean | undefined;

/**
 * Where a modelled pull request comes from: a branch of the repository itself
 * or a fork.
 */
export type PullRequestSource = 'repository' | 'fork';

export interface JobConditionContext {
	readonly action?: string;
	readonly merged?: boolean;
	readonly ref?: string;
	readonly dependencies?: ConditionOutcome;
	readonly isCancelled?: boolean;
}

export interface PullRequestActivity extends JobConditionContext {
	readonly action: string;
	readonly merged: boolean;
}

export interface JobDependencyGate {
	readonly condition: string | boolean;
	readonly dependencies: readonly JobDependencyGate[] | 'unknown';
}

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
	| { readonly kind: 'activity'; readonly field: 'action' | 'merged' | 'ref' }
	| { readonly kind: 'head-repository'; readonly field: RepositoryField }
	| { readonly kind: 'repository'; readonly field: RepositoryField }
	| { readonly kind: 'string'; readonly value: string }
	| { readonly kind: 'boolean'; readonly value: boolean }
	| {
			readonly kind: 'status';
			readonly value: 'success' | 'always' | 'cancelled';
	  }
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
const statusFunctions: ReadonlyMap<
	string,
	Extract<Expression, { kind: 'status' }>['value']
> = new Map([
	['success', 'success'],
	['always', 'always'],
	['cancelled', 'cancelled']
]);

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
			const status = statusFunctions.get(token.value.toLowerCase());

			return !hasArguments && status !== undefined
				? {
						kind: 'status',
						value: status
					}
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

		if (!isIndexed && name === 'github.event.action') {
			return { kind: 'activity', field: 'action' };
		}

		if (!isIndexed && name === 'github.event.pull_request.merged') {
			return { kind: 'activity', field: 'merged' };
		}

		if (!isIndexed && name === 'github.ref') {
			return { kind: 'activity', field: 'ref' };
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
	source: PullRequestSource,
	activity: JobConditionContext | undefined
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

	const [context, value] =
		left.kind === 'activity' ? [left, right] : [right, left];

	if (context.kind === 'activity') {
		const actual = activity?.[context.field];

		if (typeof actual === 'string' && value.kind === 'string') {
			const isEqual = actual.toLowerCase() === value.value.toLowerCase();
			return operator === '==' ? isEqual : !isEqual;
		}

		if (typeof actual === 'boolean' && value.kind === 'boolean') {
			return operator === '=='
				? actual === value.value
				: actual !== value.value;
		}

		return undefined;
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
	source: PullRequestSource,
	activity: JobConditionContext | undefined
): ConditionOutcome {
	switch (expression.kind) {
		case 'or': {
			const outcomes = expression.terms.map((term) =>
				evaluate(term, event, source, activity)
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
				evaluate(term, event, source, activity)
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
			const outcome = evaluate(expression.term, event, source, activity);

			return outcome === undefined ? undefined : !outcome;
		}
		case 'compare': {
			return compareEvent(expression, event, source, activity);
		}
		case 'activity': {
			const value = activity?.[expression.field];
			return value === undefined ? undefined : Boolean(value);
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
		case 'status': {
			if (expression.value === 'cancelled') {
				return activity?.isCancelled;
			}
			if (
				activity === undefined ||
				expression.value === 'always' ||
				!('dependencies' in activity)
			) {
				return true;
			}
			return activity.dependencies;
		}
		case 'head-repository':
		case 'repository':
		case 'unknown': {
			return undefined;
		}
	}
}

function hasStatusFunction(condition: string | boolean): ConditionOutcome {
	if (typeof condition === 'boolean') {
		return false;
	}
	if (parseCondition(condition) === undefined) {
		return undefined;
	}
	const input = tokens(expressionWrapper.exec(condition)?.[1] ?? condition);
	return input.some(
		(token, index) =>
			token.kind === 'word' &&
			['success', 'always', 'cancelled', 'failure'].includes(
				token.value.toLowerCase()
			) &&
			input[index + 1]?.value === '('
	);
}

interface DependencyState {
	readonly outcome: ConditionOutcome;
	readonly ancestorSuccess: ConditionOutcome;
	readonly isGraphVerified: boolean;
}

function allSuccessful(
	outcomes: readonly ConditionOutcome[]
): ConditionOutcome {
	if (outcomes.includes(false)) {
		return false;
	}
	if (outcomes.includes(undefined)) {
		return undefined;
	}
	return true;
}

function dependencyState(
	gate: JobDependencyGate,
	activity: PullRequestActivity
): DependencyState {
	const states =
		gate.dependencies === 'unknown'
			? []
			: gate.dependencies.map((dependency) =>
					dependencyState(dependency, activity)
				);
	const isGraphVerified =
		gate.dependencies !== 'unknown' &&
		states.every((state) => state.isGraphVerified);
	const dependencies = allSuccessful([
		...states.map((state) => state.ancestorSuccess),
		...(isGraphVerified ? [] : [undefined])
	]);
	const explicitStatus = hasStatusFunction(gate.condition);
	const condition = jobConditionOutcome(
		gate.condition,
		'pull_request',
		'repository',
		{ ...activity, dependencies }
	);
	if (
		condition === false ||
		(explicitStatus === false && dependencies === false)
	) {
		return { outcome: false, ancestorSuccess: false, isGraphVerified };
	}
	if (!isGraphVerified || (explicitStatus !== true && dependencies !== true)) {
		return {
			outcome: undefined,
			ancestorSuccess: allSuccessful([undefined, dependencies]),
			isGraphVerified
		};
	}
	return {
		outcome: condition,
		ancestorSuccess: allSuccessful([condition, dependencies]),
		isGraphVerified
	};
}

export function jobDependencyOutcome(
	gate: JobDependencyGate,
	activity: PullRequestActivity
): ConditionOutcome {
	return dependencyState(gate, activity).outcome;
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
 * The supplied context can specify `github.ref` for a verified push branch.
 * For pull requests, it can also specify `github.event.action` and
 * `github.event.pull_request.merged`.
 * `cancelled()` uses `activity.isCancelled`, and remains unknown when the
 * caller does not supply a cancellation state.
 */
export function jobConditionOutcome(
	condition: string | boolean,
	event: string,
	source: PullRequestSource = 'repository',
	activity?: JobConditionContext
): ConditionOutcome {
	if (typeof condition === 'boolean') {
		return condition;
	}

	const expression = parseCondition(condition);

	return expression === undefined
		? undefined
		: evaluate(expression, event, source, activity);
}
