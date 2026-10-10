export type CheckGroup =
	| 'static'
	| 'unit'
	| 'server'
	| 'actions'
	| 'scripts'
	| 'e2e'
	| 'remote-store'
	| 'conformance';

export interface CheckTask {
	readonly id: string;
	readonly group: CheckGroup;
	readonly checks: readonly string[];
	readonly arguments: readonly string[];
	readonly workerBudget?: number;
}

const staticChecks = [
	'check:lint',
	'check:types',
	'check:types:root',
	'check:types:tests',
	'check:types:conformance',
	'check:types:perf',
	'check:types:predecessor-fixture',
	'check:format',
	'check:knip',
	'check:action-bundles',
	'check:conformance-oracle',
	'check:deps',
	'check:flake-deps',
	'check:migrations'
] as const;

const runtimeChecks = [
	'check:test',
	'check:e2e',
	'check:e2e-remote-store',
	'check:conformance'
] as const;

export class CheckPlan {
	static fromScripts(
		scripts: Readonly<Record<string, string>>,
		workers: number
	): CheckPlan {
		const expected = new Set<string>([...staticChecks, ...runtimeChecks]);
		const actual = Object.keys(scripts).filter((key) =>
			key.startsWith('check:')
		);
		const unexpected = actual.filter((key) => !expected.has(key));
		const missing = [...expected].filter((key) => scripts[key] === undefined);
		if (unexpected.length > 0 || missing.length > 0) {
			throw new Error(
				`Check plan differs from package.json: ${[...unexpected, ...missing].join(', ')}`
			);
		}

		const workerArgument = `--maxWorkers=${String(workers)}`;
		return new CheckPlan([
			{
				id: 'server',
				group: 'server',
				workerBudget: workers,
				checks: [],
				arguments: [
					'--filter',
					'@cupboard/server',
					'run',
					'test',
					workerArgument
				]
			},
			{
				id: 'check:e2e',
				group: 'e2e',
				workerBudget: workers,
				checks: ['check:e2e'],
				arguments: ['run', 'check:e2e', workerArgument]
			},
			{
				id: 'unit',
				group: 'unit',
				workerBudget: workers,
				checks: ['check:test'],
				arguments: [
					'--workspace-concurrency=1',
					'--filter',
					'!@cupboard/server',
					'-r',
					'run',
					'test',
					workerArgument
				]
			},
			{
				id: 'actions',
				group: 'actions',
				workerBudget: workers,
				checks: [],
				arguments: ['run', 'test:actions', workerArgument]
			},
			{
				id: 'scripts',
				group: 'scripts',
				workerBudget: 1,
				checks: [],
				arguments: ['run', 'test:scripts', '--maxWorkers=1']
			},
			{
				id: 'check:e2e-remote-store',
				group: 'remote-store',
				workerBudget: workers,
				checks: ['check:e2e-remote-store'],
				arguments: ['run', 'check:e2e-remote-store', workerArgument]
			},
			{
				id: 'check:conformance',
				group: 'conformance',
				workerBudget: workers,
				checks: ['check:conformance'],
				arguments: ['run', 'check:conformance', workerArgument]
			},
			...staticChecks.map((id): CheckTask => ({
				id,
				group: 'static',
				checks: [id],
				arguments: ['run', id]
			}))
		]);
	}

	private constructor(readonly tasks: readonly CheckTask[]) {}

	select(group: CheckGroup | 'all' | 'tests'): readonly CheckTask[] {
		if (group === 'all') {
			return this.tasks;
		}
		if (group === 'tests') {
			return this.tasks.filter((task) =>
				['unit', 'server', 'actions', 'scripts'].includes(task.group)
			);
		}
		return this.tasks.filter((task) => task.group === group);
	}
}

export interface CheckResult {
	readonly id: string;
	readonly status: 'passed' | 'failed' | 'cancelled';
	readonly durationMs: number;
	readonly exitCode?: number;
	readonly error?: unknown;
}

export interface CheckExecution {
	readonly concurrency: number;
	readonly signal?: AbortSignal;
	readonly now: () => number;
	readonly execute: (task: CheckTask, signal: AbortSignal) => Promise<number>;
	readonly onResult?: (result: CheckResult) => void;
}

export async function runChecks(
	tasks: readonly CheckTask[],
	execution: CheckExecution
): Promise<readonly CheckResult[]> {
	if (
		!Number.isSafeInteger(execution.concurrency) ||
		execution.concurrency < 1
	) {
		throw new Error('Check concurrency must be a positive integer');
	}
	const signal = execution.signal ?? new AbortController().signal;
	const results = new Map<string, CheckResult>();
	let next = 0;
	async function runTask(task: CheckTask): Promise<CheckResult> {
		const started = execution.now();
		try {
			signal.throwIfAborted();
			const exitCode = await execution.execute(task, signal);
			return {
				id: task.id,
				status: signal.aborted
					? 'cancelled'
					: exitCode === 0
						? 'passed'
						: 'failed',
				durationMs: execution.now() - started,
				exitCode
			};
		} catch (error) {
			return {
				id: task.id,
				status: signal.aborted ? 'cancelled' : 'failed',
				durationMs: execution.now() - started,
				error
			};
		}
	}
	async function worker(): Promise<void> {
		while (next < tasks.length) {
			const task = tasks[next++];
			if (task === undefined) {
				return;
			}
			const result = await runTask(task);
			results.set(task.id, result);
			execution.onResult?.(result);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(execution.concurrency, tasks.length) }, () =>
			worker()
		)
	);
	return tasks.map((task) => {
		const result = results.get(task.id);
		if (result === undefined) {
			throw new Error(`No result for ${task.id}`);
		}
		return result;
	});
}
