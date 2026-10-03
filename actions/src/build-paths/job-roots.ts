import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { createRuntimeDirectory } from '@cupboard/nix/build-observation';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	observeChildProcess,
	waitForAbortableChildProcess
} from '@cupboard/shared/child-process';
import { CodedError } from '@cupboard/shared/errors';

import {
	appendEnvironmentFile,
	type Environment,
	requireEnvironment
} from '../inputs.ts';

export const jobRootsStateKey = 'cupboard-job-roots';
export const jobRootsEnvironmentKey = 'CUPBOARD_JOB_ROOTS_DIRECTORY';
const directoryPrefix = 'cupboard-build-';

export interface JobOutputProtection {
	readonly directory: string;
	protect(storePaths: readonly string[], signal?: AbortSignal): Promise<void>;
}

export class JobOutputProtectionError extends CodedError {
	constructor(
		readonly storePath: string,
		readonly status: number | null
	) {
		super(
			`Could not protect ${storePath} from garbage collection before publication (nix-store exited ${String(status)}).`
		);
		this.name = 'JobOutputProtectionError';
	}
}

export class JobRootsStateInvalidError extends CodedError {
	constructor() {
		super(
			'The build action cleanup directory is not an invocation directory beneath RUNNER_TEMP.'
		);
		this.name = 'JobRootsStateInvalidError';
	}
}

export async function createJobRoots(
	environment: Environment
): Promise<string> {
	const directory = path.join(
		path.resolve(requireEnvironment(environment, 'RUNNER_TEMP')),
		`${directoryPrefix}${randomUUID()}`
	);
	await appendEnvironmentFile(
		environment.GITHUB_STATE,
		`${jobRootsStateKey}=${directory}\n`
	);
	await createRuntimeDirectory(directory);

	return directory;
}

export async function removeJobRoots(environment: Environment): Promise<void> {
	const directory = environment[`STATE_${jobRootsStateKey}`];
	if (directory === undefined || directory === '') {
		return;
	}

	const runnerTemporary = path.resolve(
		requireEnvironment(environment, 'RUNNER_TEMP')
	);
	const resolved = path.resolve(directory);
	const basename = path.basename(resolved);
	if (
		path.dirname(resolved) !== runnerTemporary ||
		!/^cupboard-build-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u.test(basename)
	) {
		throw new JobRootsStateInvalidError();
	}

	await rm(resolved, { recursive: true, force: true });
}

export function jobOutputProtection(
	directory: string,
	storeUri: string
): JobOutputProtection {
	return {
		directory,
		async protect(storePaths, signal) {
			for (const storePath of storePaths) {
				signal?.throwIfAborted();
				const parsed = new StorePath(storePath);
				const root = path.join(directory, parsed.hash);
				const child = spawn(
					'nix-store',
					[
						'--store',
						storeUri,
						'--realise',
						storePath,
						'--add-root',
						root,
						'--indirect'
					],
					{ stdio: ['ignore', 'ignore', 'inherit'] }
				);
				const result = await waitForAbortableChildProcess(
					observeChildProcess(child),
					signal
				);
				if (result.error !== undefined) {
					throw result.error;
				}
				if (result.status !== 0) {
					throw new JobOutputProtectionError(storePath, result.status);
				}
			}
		}
	};
}
