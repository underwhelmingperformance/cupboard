import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { CodedError } from '@cupboard/shared/errors';

import type { Environment } from '../inputs.ts';

const execute = promisify(execFile);

export type ExecuteHookProbe = (
	hook: string,
	environment: Environment
) => Promise<void>;

class BuilderHookCapabilityError extends CodedError {
	constructor(options?: ErrorOptions) {
		super(
			'Cannot verify execution of the job-specific Nix build hook. Check the Nix error and ensure the store process can read and execute files in /tmp.',
			options
		);
		this.name = 'BuilderHookCapabilityError';
	}
}

class BuilderHookExecutableError extends CodedError {
	constructor(command: string) {
		super(`The Nix store cannot execute its configured build hook: ${command}`);
		this.name = 'BuilderHookExecutableError';
	}
}

async function executeStoreProbe(
	hook: string,
	environment: Environment
): Promise<void> {
	await execute(
		'nix',
		[
			'build',
			'--no-link',
			'--impure',
			'--max-jobs',
			'0',
			'--option',
			'builders',
			'',
			'--option',
			'substituters',
			'',
			'--option',
			'build-hook',
			hook,
			'--expr',
			`derivation { name = "cupboard-hook-probe-${randomUUID()}"; system = builtins.currentSystem; builder = "/cupboard-hook-probe-cannot-build"; preferLocalBuild = false; allowSubstitutes = false; }`
		],
		{ env: { ...environment }, timeout: 30_000, maxBuffer: 1024 * 1024 }
	);
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Resolves the configured hook in the process that will execute remote builds.
 */
export async function probeBuildHook(options: {
	readonly directory: string;
	readonly command: string;
	readonly environment: Environment;
	readonly executeProbe?: ExecuteHookProbe;
	readonly workerPath?: string;
}): Promise<string> {
	const hook = path.join(options.directory, 'probe');
	const result = path.join(options.directory, 'probe-result');
	await writeFile(result, '', { mode: 0o600 });
	await chmod(result, 0o600);
	const worker =
		options.workerPath ??
		path.join(
			path.dirname(process.argv[1] ?? process.execPath),
			'probe-worker.cjs'
		);
	await writeFile(
		hook,
		`#!/bin/sh\nexec ${[process.execPath, worker, result, options.command].map((argument) => shellQuote(argument)).join(' ')}\n`,
		{ mode: 0o700 }
	);
	await chmod(hook, 0o700);
	let failure: unknown;
	try {
		await (options.executeProbe ?? executeStoreProbe)(
			hook,
			options.environment
		);
	} catch (error) {
		// The probe declines the build and max-jobs=0 prevents a local fallback.
		if (!(error instanceof Error) || !('code' in error) || error.code !== 1) {
			throw new BuilderHookCapabilityError({ cause: error });
		}
		failure = error;
	}
	const outcome = await readFile(result, 'utf8');
	if (!outcome.startsWith('started\n')) {
		throw new BuilderHookCapabilityError({ cause: failure });
	}
	const executable = outcome.slice('started\n'.length);
	if (executable === '') {
		throw new BuilderHookExecutableError(options.command);
	}
	await Promise.all([rm(hook), rm(result)]);
	return executable;
}
