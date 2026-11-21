/**
`true` or `false` when the result of a job condition follows from the event
name. For `pull_request`, the result can also use the source and activity of
the modelled pull request. Otherwise `undefined`.
*/
export type ConditionOutcome = boolean | undefined;

/**
Where a modelled pull request comes from: a branch of the repository itself
or a fork.
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
	| { readonly kind: 'number'; readonly value: number }
	| { readonly kind: 'null' }
	| { readonly kind: 'input'; readonly name: string }
	| {
			readonly kind: 'status';
			readonly value: 'success' | 'always' | 'cancelled';
	  }
	| { readonly kind: 'unknown'; readonly text: string };

/**
A value of the GitHub Actions expression language other than an object or
an array. `undefined` is the language's `null`.
*/
export type ExpressionValue = string | number | boolean | undefined;

/**
The values that one modelled run supplies to an expression. `ref` is the
run's `github.ref`, when the model fixes it. `inputs` has the run's
`inputs` context, keyed by lowercase input name. For a `pull_request` run,
the pull request comes from the repository itself.
*/
export interface ExpressionRun {
	readonly event: string;
	readonly repository: { readonly fullName: string; readonly id: number };
	readonly ref?: string;
	readonly inputs: Readonly<Record<string, string | number | boolean>>;
}

/**
The value of an expression for one run, or the first part of the expression
that the evaluator does not support.
*/
export type ExpressionResult =
	| { readonly outcome: 'value'; readonly value: ExpressionValue }
	| { readonly outcome: 'unsupported'; readonly part: string };

/**
The inputs that an expression reads, as lowercase names, or the first part
of the expression that the evaluator does not support.
*/
export type ExpressionInputs =
	| { readonly outcome: 'supported'; readonly inputs: readonly string[] }
	| { readonly outcome: 'unsupported'; readonly part: string };

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
const inputContext = /^inputs\.([a-z_][\w-]*)$/u;
const decimalNumber = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu;
const hexadecimalNumber = /^0x[\dA-Fa-f]+$/u;
const octalNumber = /^0o[0-7]+$/u;

/**
Reads the digits of a `0x` or `0o` integer as the runner's .NET conversion
to a signed 32-bit integer does: as the bits of a two's complement value, so
that 0x80000000 to 0xFFFFFFFF are negative. A value of more than 32 bits
fails the conversion, and the runner then returns NaN.
*/
function signedInt32(digits: string, radix: number): number {
	const unsigned = Number.parseInt(digits, radix);

	if (unsigned > 0xff_ff_ff_ff) {
		return NaN;
	}

	return unsigned > 0x7f_ff_ff_ff ? unsigned - 2 ** 32 : unsigned;
}

/**
Converts a string to a number as the GitHub Actions runner does, for number
literals and for comparisons of a string with another type. The runner
trims the string, reads an empty string as 0, accepts decimal numbers with
an optional sign and exponent, `0x` and `0o` integers, `Infinity` and
`-Infinity`, and reads anything else as NaN. See
`ExpressionUtility.ParseNumber` in
https://github.com/actions/runner/blob/main/src/Sdk/DTExpressions2/Expressions2/Sdk/ExpressionUtility.cs.
*/
function parseNumber(text: string): number {
	const trimmed = text.trim();

	if (trimmed === '') {
		return 0;
	}

	if (decimalNumber.test(trimmed)) {
		return Number(trimmed);
	}

	if (hexadecimalNumber.test(trimmed)) {
		return signedInt32(trimmed.slice(2), 16);
	}

	if (octalNumber.test(trimmed)) {
		return signedInt32(trimmed.slice(2), 8);
	}

	if (trimmed === 'Infinity') {
		return Infinity;
	}

	return trimmed === '-Infinity' ? -Infinity : NaN;
}

// GitHub reads false, 0, -0, NaN, an empty string and null as false, and every
// other value as true. See "Operators" in
// https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
// and `EvaluationResult.IsFalsy` in
// https://github.com/actions/runner/blob/main/src/Sdk/DTExpressions2/Expressions2/EvaluationResult.cs.
function isTruthy(value: ExpressionValue): boolean {
	return (
		value !== false &&
		value !== 0 &&
		value !== '' &&
		value !== undefined &&
		!Number.isNaN(value)
	);
}

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

			return hasArguments || status === undefined
				? { kind: 'unknown', text: `${token.value}()` }
				: {
						kind: 'status',
						value: status
					};
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

		if (isIndexed) {
			return { kind: 'unknown', text: `${token.value}[...]` };
		}

		if (token.value === 'true' || token.value === 'false') {
			return { kind: 'boolean', value: token.value === 'true' };
		}

		if (token.value === 'null') {
			return { kind: 'null' };
		}

		const input = inputContext.exec(name)?.[1];

		if (input !== undefined) {
			return { kind: 'input', name: input };
		}

		const number = parseNumber(token.value);

		if (!Number.isNaN(number)) {
			return { kind: 'number', value: number };
		}

		return { kind: 'unknown', text: token.value };
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
		case 'number':
		case 'null':
		case 'input':
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
Evaluates whether a job's `if` value allows the job to run for one event.
The evaluator handles comparisons of `github.event_name` with a string
literal, the guard that compares a pull request's head repository with the
repository, and the status functions `success()` and `always()`, combined
with `&&`, `||`, `!` and parentheses. It treats every other term as unknown.
An `if` value may be written with or without the `${{ }}` wrapper, because
GitHub accepts both. For `pull_request`, the guard is true when `source` is
`repository` and false when it is `fork`.
The supplied context can specify `github.ref` for a verified push branch.
For pull requests, it can also specify `github.event.action` and
`github.event.pull_request.merged`.
`cancelled()` uses `activity.isCancelled`, and remains unknown when the
caller does not supply a cancellation state.
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

function numericValue(value: ExpressionValue): number {
	if (value === undefined) {
		return 0;
	}

	if (typeof value === 'boolean') {
		return value ? 1 : 0;
	}

	return typeof value === 'number' ? value : parseNumber(value);
}

// GitHub compares two values of the same type directly, and strings without
// regard to case. It compares values of different types by their numeric
// values, so `true == 1` and `'' == null` are true. See "Operators" in the
// expressions documentation and `EvaluationResult.AbstractEqual` in the
// runner.
function isLooselyEqual(
	left: ExpressionValue,
	right: ExpressionValue
): boolean {
	if (typeof left === 'string' && typeof right === 'string') {
		return left.toLowerCase() === right.toLowerCase();
	}

	if (typeof left !== typeof right) {
		return numericValue(left) === numericValue(right);
	}

	return left === right;
}

const unsupportedContexts: Readonly<Record<'action' | 'merged', string>> = {
	action: 'github.event.action',
	merged: 'github.event.pull_request.merged'
};

function unsupported(part: string): ExpressionResult {
	return { outcome: 'unsupported', part };
}

function value(result: ExpressionValue): ExpressionResult {
	return { outcome: 'value', value: result };
}

function evaluateValue(
	expression: Expression,
	run: ExpressionRun
): ExpressionResult {
	switch (expression.kind) {
		case 'or':
		case 'and': {
			const values: ExpressionValue[] = [];

			for (const term of expression.terms) {
				const result = evaluateValue(term, run);

				if (result.outcome === 'unsupported') {
					return result;
				}

				values.push(result.value);
			}

			// `&&` and `||` return one of their operands, not a boolean: `&&` the
			// first falsy operand and `||` the first truthy operand, or otherwise
			// the last operand. See `And.EvaluateCore` and `Or.EvaluateCore` in
			// https://github.com/actions/runner/tree/main/src/Sdk/DTExpressions2/Expressions2/Sdk/Operators.
			const isOr = expression.kind === 'or';
			const deciding = values.findIndex(
				(operand) => isTruthy(operand) === isOr
			);

			return value(deciding === -1 ? values.at(-1) : values[deciding]);
		}
		case 'not': {
			const result = evaluateValue(expression.term, run);

			return result.outcome === 'unsupported'
				? result
				: value(!isTruthy(result.value));
		}
		case 'compare': {
			if (expression.operator !== '==' && expression.operator !== '!=') {
				return unsupported(`the ${expression.operator} operator`);
			}

			const left = evaluateValue(expression.left, run);

			if (left.outcome === 'unsupported') {
				return left;
			}

			const right = evaluateValue(expression.right, run);

			if (right.outcome === 'unsupported') {
				return right;
			}

			return value(
				isLooselyEqual(left.value, right.value) ===
					(expression.operator === '==')
			);
		}
		case 'event': {
			return value(run.event);
		}
		case 'activity': {
			if (expression.field !== 'ref') {
				return unsupported(unsupportedContexts[expression.field]);
			}

			return run.ref === undefined ? unsupported('github.ref') : value(run.ref);
		}
		// A run for any other event has no pull request, and GitHub evaluates a
		// property of a missing object as an empty string. See "Available
		// contexts" in
		// https://docs.github.com/en/actions/reference/workflows-and-actions/contexts.
		case 'head-repository': {
			if (run.event !== 'pull_request') {
				return value('');
			}

			return value(
				expression.field === 'id' ? run.repository.id : run.repository.fullName
			);
		}
		// `github.repository_id` is a string, unlike the numeric ID of the pull
		// request's head repository.
		case 'repository': {
			return value(
				expression.field === 'id'
					? String(run.repository.id)
					: run.repository.fullName
			);
		}
		case 'string':
		case 'boolean':
		case 'number': {
			return value(expression.value);
		}
		case 'null': {
			return value(undefined);
		}
		// The inputs object inherits properties such as `constructor`, which are
		// not inputs.
		case 'input': {
			return Object.hasOwn(run.inputs, expression.name)
				? value(run.inputs[expression.name])
				: unsupported(`inputs.${expression.name}`);
		}
		case 'status': {
			return unsupported(`${expression.value}()`);
		}
		case 'unknown': {
			return unsupported(expression.text);
		}
	}
}

function parseValueExpression(
	source: string
):
	| { readonly outcome: 'parsed'; readonly expression: Expression }
	| { readonly outcome: 'unsupported'; readonly part: string } {
	const body = expressionWrapper.exec(source)?.[1];

	if (body === undefined || body.includes('${{')) {
		return { outcome: 'unsupported', part: `'${source}'` };
	}

	try {
		return { outcome: 'parsed', expression: new Parser(tokens(body)).parse() };
	} catch (error) {
		if (error instanceof ConditionSyntaxError) {
			return {
				outcome: 'unsupported',
				part: `the expression '${source.trim()}'`
			};
		}

		throw error;
	}
}

function subexpressions(expression: Expression): readonly Expression[] {
	switch (expression.kind) {
		case 'or':
		case 'and': {
			return expression.terms;
		}
		case 'not': {
			return [expression.term];
		}
		case 'compare': {
			return [expression.left, expression.right];
		}
		default: {
			return [];
		}
	}
}

function inputNames(expression: Expression): Set<string> {
	const names = new Set<string>();
	const pending = [expression];

	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		if (node.kind === 'input') {
			names.add(node.name);
		}

		pending.push(...subexpressions(node));
	}

	return names;
}

/**
Evaluates a value of the form `${{ <expression> }}` for one run, with the
semantics of GitHub Actions expressions. The evaluator supports boolean,
null, number and string literals, `&&`, `||`, `!`, `==`, `!=`, parentheses,
`inputs.<name>`, `github.event_name`, `github.ref`, `github.repository`,
`github.repository_id`, and the full name and ID of a pull request's head
repository. It returns the first other part of the expression as
unsupported, even when the result does not depend on that part.
*/
export function evaluateExpression(
	source: string,
	run: ExpressionRun
): ExpressionResult {
	const parsed = parseValueExpression(source);

	return parsed.outcome === 'unsupported'
		? parsed
		: evaluateValue(parsed.expression, run);
}

/**
Lists the inputs that a value of the form `${{ <expression> }}` reads, so
that a caller can resolve them before it calls `evaluateExpression`.
*/
export function expressionInputs(source: string): ExpressionInputs {
	const parsed = parseValueExpression(source);

	if (parsed.outcome === 'unsupported') {
		return parsed;
	}

	const inputs = [...inputNames(parsed.expression)];
	// This run supplies every input and `github.ref`, so the evaluation reports
	// only the parts that no run can supply.
	const probe = evaluateValue(parsed.expression, {
		event: '',
		repository: { fullName: '', id: 0 },
		ref: '',
		inputs: Object.fromEntries(inputs.map((name) => [name, '']))
	});

	return probe.outcome === 'unsupported'
		? probe
		: { outcome: 'supported', inputs };
}
