import { readFile } from 'node:fs/promises';

import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';

import manifest from '../package.json';

import { CheckPlan, type CheckTask, runChecks } from './check-runner.ts';

describe('check plan', () => {
	it('assigns explicit budgets to every runtime task', () => {
		const tasks = CheckPlan.fromScripts(manifest.scripts, 2).tasks;
		expect(
			tasks
				.filter(({ group }) => group !== 'static')
				.map(({ workerBudget }) => workerBudget)
		).toStrictEqual([2, 2, 2, 2, 1, 2, 2]);
		expect(
			tasks
				.filter(({ group }) => group === 'static')
				.every(({ workerBudget }) => workerBudget === undefined)
		).toBe(true);
	});
	it.each([1, 4])(
		'uses one script worker within a runtime budget of %i',
		(workers) => {
			expect(
				CheckPlan.fromScripts(manifest.scripts, workers).select('scripts')
			).toStrictEqual([
				{
					id: 'scripts',
					group: 'scripts',
					workerBudget: 1,
					checks: [],
					arguments: ['run', 'test:scripts', '--maxWorkers=1']
				}
			]);
		}
	);
	it('accounts for every source check exactly once', () => {
		const plan = CheckPlan.fromScripts(manifest.scripts, 2);
		expect(
			plan.tasks.flatMap((task) => task.checks).toSorted(byCodeUnit)
		).toStrictEqual(
			Object.keys(manifest.scripts)
				.filter((key) => key.startsWith('check:'))
				.toSorted(byCodeUnit)
		);
		expect(plan.tasks.slice(0, 2).map(({ group }) => group)).toStrictEqual([
			'server',
			'e2e'
		]);
	});

	it('rejects a newly added check without an execution group', () => {
		expect(() =>
			CheckPlan.fromScripts({ ...manifest.scripts, 'check:extra': 'true' }, 2)
		).toThrow('check:extra');
	});

	it('rejects a removed check rather than silently omitting it', () => {
		const { 'check:migrations': _removed, ...scripts } = manifest.scripts;
		expect(() => CheckPlan.fromScripts(scripts, 2)).toThrow('check:migrations');
	});

	it('keeps the four test groups in the standalone test gate', () => {
		expect(
			CheckPlan.fromScripts(manifest.scripts, 2)
				.select('tests')
				.map(({ group }) => group)
		).toStrictEqual(['server', 'unit', 'actions', 'scripts']);
	});
});

const preCommitHookSchema = z.object({
	id: z.string(),
	entry: z.string().optional()
});
const preCommitRepositorySchema = z.object({
	hooks: z.array(preCommitHookSchema)
});
const preCommitConfigSchema = z.object({
	repos: z.array(preCommitRepositorySchema)
});

async function loadTypeCheckHookSelector(): Promise<RegExp> {
	const configFile = new URL('../.pre-commit-config.yaml', import.meta.url);
	const document: unknown = parse(await readFile(configFile, 'utf8'));
	const config = preCommitConfigSchema.parse(document);
	const hook = config.repos
		.flatMap((repository) => repository.hooks)
		.find(({ id }) => id === 'pnpm-check-types');
	const selector = hook?.entry
		?.split(' ')
		.find((argument) => /^\/.+\/$/.test(argument));
	if (selector === undefined) {
		throw new Error('The pnpm-check-types hook has no script selector');
	}

	return new RegExp(selector.slice(1, -1));
}

describe('type-check commit hook', () => {
	it('selects every script that type-checks a project', async () => {
		const selector = await loadTypeCheckHookSelector();
		expect(
			Object.entries(manifest.scripts)
				.filter(
					([key, command]) =>
						key === 'check:types' ||
						(key.startsWith('check:') && /\btsc\b/.test(command))
				)
				.map(([key]) => key)
				.filter((key) => !selector.test(key))
		).toStrictEqual([]);
	});
});

const task = (id: string): CheckTask => ({
	id,
	group: 'static',
	checks: [id],
	arguments: ['run', id]
});

describe('check scheduler', () => {
	it('bounds execution and continues after a failed check', async () => {
		const first = Promise.withResolvers<number>();
		const second = Promise.withResolvers<number>();
		const thirdStarted = Promise.withResolvers<undefined>();
		const started: string[] = [];
		const running = runChecks([task('a'), task('b'), task('c')], {
			concurrency: 2,
			now: () => 0,
			execute: (item) => {
				started.push(item.id);
				if (item.id === 'a') {
					return first.promise;
				}
				if (item.id === 'b') {
					return second.promise;
				}
				thirdStarted.resolve(undefined);
				return Promise.resolve(0);
			}
		});
		expect(started).toStrictEqual(['a', 'b']);
		first.resolve(1);
		await thirdStarted.promise;
		expect(started).toStrictEqual(['a', 'b', 'c']);
		second.resolve(0);
		expect(await running).toStrictEqual([
			{ id: 'a', status: 'failed', durationMs: 0, exitCode: 1 },
			{ id: 'b', status: 'passed', durationMs: 0, exitCode: 0 },
			{ id: 'c', status: 'passed', durationMs: 0, exitCode: 0 }
		]);
	});

	it('aborts running work without starting queued tasks', async () => {
		const controller = new AbortController();
		const started: string[] = [];
		const cancelled = new Error('cancelled');
		const running = runChecks([task('a'), task('b')], {
			concurrency: 1,
			signal: controller.signal,
			now: () => 0,
			execute: (item, signal) => {
				started.push(item.id);
				return new Promise((_resolve, reject) => {
					signal.addEventListener(
						'abort',
						() => {
							reject(cancelled);
						},
						{
							once: true
						}
					);
				});
			}
		});
		controller.abort(cancelled);
		expect(await running).toStrictEqual([
			{ id: 'a', status: 'cancelled', durationMs: 0, error: cancelled },
			{ id: 'b', status: 'cancelled', durationMs: 0, error: cancelled }
		]);
		expect(started).toStrictEqual(['a']);
	});
});
