import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

/**
The directories to lint, each in its own ESLint process, most specific
first. The typescript-eslint project service keeps every TypeScript program
that it opens until its process exits. A single `eslint .` therefore keeps
the programs and type checkers of every tsconfig in memory at once, which
needs more than Node's default heap. A separate process for each scope frees
one scope's programs before the next scope starts.
*/
export const lintScopes = ['packages/server', 'packages', '.'] as const;

/**
Options that behave the same when each scope's process receives them. Paths
would be linted by more than one scope, and reporting options such as
`--format`, `--output-file` and `--max-warnings` would apply to each scope's
report separately.
*/
const scopeIndependentOptions = new Set([
	'--fix',
	'--quiet',
	'--color',
	'--no-color'
]);

/**
ESLint's exit status when linting could not finish.
*/
const fatalStatus = 2;

export class MisorderedLintScopeError extends Error {
	constructor(
		readonly scope: string,
		readonly containingScope: string
	) {
		super(
			`Lint scope ${scope} is listed after ${containingScope}, which contains it`
		);
		this.name = 'MisorderedLintScopeError';
	}
}

export class UnsupportedLintArgumentError extends Error {
	constructor(readonly argument: string) {
		super(
			`The lint script accepts only ${[...scopeIndependentOptions].join(', ')}, not ${argument}`
		);
		this.name = 'UnsupportedLintArgumentError';
	}
}

/**
One ESLint process: a scope, minus the scopes nested inside it.
*/
export class LintRun {
	readonly ignorePatterns: readonly string[];

	constructor(
		readonly scope: string,
		nestedScopes: readonly string[]
	) {
		this.ignorePatterns = nestedScopes.map((nested) => `${nested}/`);
	}

	eslintArguments(extra: readonly string[]): string[] {
		return [
			this.scope,
			...this.ignorePatterns.flatMap((pattern) => [
				'--ignore-pattern',
				pattern
			]),
			...extra
		];
	}
}

export type LintProcessResult =
	{ readonly status: number } | { readonly signal: NodeJS.Signals };

export interface LintEnvironment {
	announce(run: LintRun): void;
	spawn(eslintArguments: readonly string[]): LintProcessResult;
	reportSignal(run: LintRun, signal: NodeJS.Signals): void;
}

function isInside(file: string, directory: string): boolean {
	const relative = path.relative(directory, file);
	return (
		relative !== '' &&
		relative.split(path.sep)[0] !== '..' &&
		!path.isAbsolute(relative)
	);
}

export function planLintRuns(scopes: readonly string[]): LintRun[] {
	return scopes.map((scope, index) => {
		const earlier = scopes.slice(0, index);
		const containingScope = earlier.find((other) => isInside(scope, other));
		if (containingScope !== undefined) {
			throw new MisorderedLintScopeError(scope, containingScope);
		}

		const nested = earlier.filter((other) => isInside(other, scope));
		return new LintRun(
			scope,
			nested.filter((inner) => nested.every((outer) => !isInside(inner, outer)))
		);
	});
}

/**
Lints every scope, including those after a failed one, and returns the most
severe exit status.
*/
export function runLint(
	extra: readonly string[],
	environment: LintEnvironment
): number {
	const unsupported = extra.find(
		(argument) => !scopeIndependentOptions.has(argument)
	);
	if (unsupported !== undefined) {
		throw new UnsupportedLintArgumentError(unsupported);
	}

	let exitStatus = 0;
	for (const run of planLintRuns(lintScopes)) {
		environment.announce(run);
		const result = environment.spawn(run.eslintArguments(extra));
		if ('signal' in result) {
			environment.reportSignal(run, result.signal);
			exitStatus = Math.max(exitStatus, fatalStatus);
			continue;
		}

		exitStatus = Math.max(exitStatus, result.status);
	}

	return exitStatus;
}

function main(): void {
	const eslintPackage = fileURLToPath(
		import.meta.resolve('eslint/package.json')
	);
	const eslint = path.join(path.dirname(eslintPackage), 'bin/eslint.js');
	process.exitCode = runLint(process.argv.slice(2), {
		announce(run) {
			const ignored = run.ignorePatterns.join(', ');
			const exclusion = ignored === '' ? '' : `, except ${ignored}`;
			process.stdout.write(`Linting ${run.scope}${exclusion}\n`);
		},
		spawn(eslintArguments) {
			const result = spawnSync(process.execPath, [eslint, ...eslintArguments], {
				cwd: root,
				stdio: 'inherit'
			});
			if (result.error !== undefined) {
				throw result.error;
			}

			if (result.signal !== null) {
				return { signal: result.signal };
			}

			return { status: result.status ?? fatalStatus };
		},
		reportSignal(run, signal) {
			process.stderr.write(
				`ESLint was killed by ${signal} while linting ${run.scope}\n`
			);
		}
	});
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main();
}
