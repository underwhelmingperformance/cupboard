import path from 'node:path';

import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
	type LintEnvironment,
	type LintProcessResult,
	lintScopes,
	MisorderedLintScopeError,
	planLintRuns,
	runLint,
	UnsupportedLintArgumentError
} from './lint.ts';

const root = path.resolve(import.meta.dirname, '..');

async function lintedFiles(
	target: string,
	ignorePatterns: readonly string[]
): Promise<string[]> {
	const eslint = new ESLint({
		cwd: root,
		ignorePatterns: [...ignorePatterns],
		ruleFilter: () => false,
		overrideConfig: {
			languageOptions: { parserOptions: { projectService: false } }
		}
	});
	const results = await eslint.lintFiles([target]);
	return results.map((result) => path.relative(root, result.filePath));
}

const passed: LintProcessResult = { status: 0 };

type Event =
	| { readonly announce: string }
	| { readonly spawn: readonly string[] }
	| { readonly signal: string; readonly scope: string };

function fakeEnvironment(results: readonly LintProcessResult[]): {
	readonly events: Event[];
	readonly environment: LintEnvironment;
} {
	const events: Event[] = [];
	const pending = [...results];
	return {
		events,
		environment: {
			announce(run) {
				events.push({ announce: run.scope });
			},
			spawn(eslintArguments) {
				events.push({ spawn: eslintArguments });
				return pending.shift() ?? passed;
			},
			reportSignal(run, signal) {
				events.push({ signal, scope: run.scope });
			}
		}
	};
}

describe('lint plan', () => {
	it('lints each scope in its own run and leaves nested scopes to their runs', () => {
		expect(
			planLintRuns(lintScopes).map((run) => run.eslintArguments(['--fix']))
		).toStrictEqual([
			['packages/server', '--fix'],
			['packages', '--ignore-pattern', 'packages/server/', '--fix'],
			['.', '--ignore-pattern', 'packages/', '--fix']
		]);
	});

	it('lints the same files as a single run, each in exactly one scope', async () => {
		const single = await lintedFiles('.', []);
		const split: string[] = [];
		for (const run of planLintRuns(lintScopes)) {
			split.push(...(await lintedFiles(run.scope, run.ignorePatterns)));
		}

		expect(single).not.toHaveLength(0);
		expect(split.toSorted(byCodeUnit)).toStrictEqual(
			single.toSorted(byCodeUnit)
		);
	});

	it.each([
		{
			scopes: ['packages', 'packages/server', '.'],
			scope: 'packages/server',
			containingScope: 'packages'
		},
		{ scopes: ['.', 'packages'], scope: 'packages', containingScope: '.' }
	])(
		'rejects $scopes, which lists a scope after one that contains it',
		({ scopes, scope, containingScope }) => {
			let thrown: unknown;
			try {
				planLintRuns(scopes);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(MisorderedLintScopeError);
			expect(thrown).toMatchObject({ scope, containingScope });
		}
	);
});

describe('lint runner', () => {
	it.each([[[]], [['--fix']], [['--fix', '--quiet', '--no-color']]])(
		'passes %j to every scope',
		(extra) => {
			const { events, environment } = fakeEnvironment([]);

			expect(runLint(extra, environment)).toBe(0);
			expect(events).toStrictEqual([
				{ announce: 'packages/server' },
				{ spawn: ['packages/server', ...extra] },
				{ announce: 'packages' },
				{
					spawn: ['packages', '--ignore-pattern', 'packages/server/', ...extra]
				},
				{ announce: '.' },
				{ spawn: ['.', '--ignore-pattern', 'packages/', ...extra] }
			]);
		}
	);

	it.each([
		'packages/cli/src/main.ts',
		'.',
		'--format',
		'--format=json',
		'--output-file',
		'-o',
		'--max-warnings',
		'--cache'
	])('refuses %s before starting ESLint', (argument) => {
		const { events, environment } = fakeEnvironment([]);
		let thrown: unknown;
		try {
			runLint(['--fix', argument], environment);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(UnsupportedLintArgumentError);
		expect(thrown).toMatchObject({ argument });
		expect(events).toStrictEqual([]);
	});

	it.each([
		{ statuses: [0, 0, 0], expected: 0 },
		{ statuses: [1, 0, 0], expected: 1 },
		{ statuses: [2, 1, 0], expected: 2 },
		{ statuses: [0, 1, 2], expected: 2 }
	])(
		'exits $expected when the scopes exit $statuses',
		({ statuses, expected }) => {
			const { events, environment } = fakeEnvironment(
				statuses.map((status) => ({ status }))
			);

			expect(runLint([], environment)).toBe(expected);
			expect(events.filter((event) => 'spawn' in event)).toHaveLength(3);
		}
	);

	it('reports the scope of a process killed by a signal and fails', () => {
		const { events, environment } = fakeEnvironment([
			passed,
			{ signal: 'SIGABRT' },
			passed
		]);

		expect(runLint([], environment)).toBe(2);
		expect(events).toStrictEqual([
			{ announce: 'packages/server' },
			{ spawn: ['packages/server'] },
			{ announce: 'packages' },
			{ spawn: ['packages', '--ignore-pattern', 'packages/server/'] },
			{ signal: 'SIGABRT', scope: 'packages' },
			{ announce: '.' },
			{ spawn: ['.', '--ignore-pattern', 'packages/'] }
		]);
	});
});
