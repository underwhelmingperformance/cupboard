import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import {
	observeChildProcess,
	waitForAbortableChildProcess
} from '@cupboard/shared/child-process';

import type { CheckTask } from './check-runner.ts';

const root = path.resolve(import.meta.dirname, '..');

export interface CheckCommand {
	readonly command: string;
	readonly arguments: readonly string[];
}

export function packageManagerInvocation(
	executable: string | undefined
): CheckCommand {
	if (executable === undefined) {
		return { command: 'pnpm', arguments: [] };
	}
	if (['.js', '.cjs', '.mjs'].includes(path.extname(executable))) {
		return { command: process.execPath, arguments: [executable] };
	}
	return { command: executable, arguments: [] };
}

export async function executeCheck(
	task: CheckTask,
	signal: AbortSignal
): Promise<number> {
	signal.throwIfAborted();
	const pnpmPath = process.env.npm_execpath;
	const invocation = packageManagerInvocation(pnpmPath);
	const child = spawn(
		invocation.command,
		[...invocation.arguments, ...task.arguments],
		{
			cwd: root,
			stdio: 'inherit',
			detached: process.platform !== 'win32',
			env: {
				...process.env,
				...(task.workerBudget !== undefined && {
					CUPBOARD_TEST_WORKERS: String(task.workerBudget)
				})
			}
		}
	);
	const lifecycle = {
		...observeChildProcess(child),
		kill(terminationSignal: NodeJS.Signals) {
			if (process.platform === 'win32' || child.pid === undefined) {
				return child.kill(terminationSignal);
			}
			try {
				process.kill(-child.pid, terminationSignal);
				return true;
			} catch (error) {
				if (
					error instanceof Error &&
					'code' in error &&
					error.code === 'ESRCH'
				) {
					return false;
				}
				throw error;
			}
		}
	};
	try {
		const result = await waitForAbortableChildProcess(lifecycle, signal);
		if (result.error !== undefined) {
			throw result.error;
		}
		return result.status ?? 1;
	} finally {
		lifecycle.kill('SIGKILL');
	}
}
