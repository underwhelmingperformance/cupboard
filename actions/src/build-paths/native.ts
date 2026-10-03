import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import { PostBuildHookConflictError } from '@cupboard/nix/build-observation';
import {
	observeChildProcess,
	waitForAbortableChildProcess
} from '@cupboard/shared/child-process';
import { CodedError, formatErrorWithCauses } from '@cupboard/shared/errors';
import { workflowCommands } from '@cupboard/shared/github-actions';
import { z } from 'zod';

import type { BuildOptions } from '../commands/build.ts';
import { CommandFailedError } from '../errors.ts';
import { type Environment, parseLines, requireEnvironment } from '../inputs.ts';
import { provided } from '../options.ts';

import {
	createJobRoots,
	jobRootsEnvironmentKey,
	removeJobRoots
} from './job-roots.ts';

export function buildPathInputs(environment: Environment): BuildOptions {
	const input = (name: string): string | undefined =>
		environment[`INPUT_${name.toUpperCase()}`];
	return {
		installables: parseLines(input('installables') ?? ''),
		installablesFile: input('installables-file'),
		inlinePaths: input('inline-paths'),
		cupboardPath: input('cupboard-path'),
		keepGoing: input('keep-going'),
		maxJobs: input('max-jobs'),
		allowFailure: input('allow-failure'),
		build: input('build'),
		requireProvenance: input('require-provenance'),
		publish: provided(input('publish')) ?? 'built',
		substituter: input('substituter'),
		publicationUrl: input('publication-url')
	};
}

export async function nativeBuildMain(
	environment: Environment,
	signal?: AbortSignal
): Promise<void> {
	const directory = await createJobRoots(environment);
	const childEnvironment = {
		...environment,
		[jobRootsEnvironmentKey]: directory
	};
	const target = environment['INPUT_READ-SESSION-TARGET'] ?? '';
	const worker = [
		process.execPath,
		path.join(path.dirname(process.argv[1] ?? process.execPath), 'worker.cjs')
	];
	let command = worker;
	if (target !== '') {
		const cupboard = requireEnvironment(environment, 'INPUT_CUPBOARD-PATH');
		const audience = environment.INPUT_AUDIENCE?.trim();
		const cacheInput: unknown = JSON.parse(
			environment['INPUT_READ-SESSION-CACHES'] === ''
				? '[]'
				: (environment['INPUT_READ-SESSION-CACHES'] ?? '[]')
		);
		const caches = z.array(z.string().regex(/^[^\r\n]*$/u)).parse(cacheInput);
		const view = environment['INPUT_READ-SESSION-VIEW'];
		command = [
			cupboard,
			'run',
			target,
			'--github-oidc',
			...(audience === undefined || audience === ''
				? []
				: ['--audience', audience]),
			...caches.flatMap((cache) =>
				cache === '' ? [] : ['--read-cache', cache]
			),
			...(view === undefined || view === '' ? [] : ['--reuse-view', view]),
			'--',
			...worker
		];
	}

	const [executable, ...arguments_] = command;
	if (executable === undefined) {
		throw new CommandFailedError('build worker', -1);
	}
	const child = spawn(executable, arguments_, {
		stdio: 'inherit',
		env: childEnvironment
	});
	const result = await waitForAbortableChildProcess(
		observeChildProcess(child),
		signal
	);
	if (result.error !== undefined) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new CommandFailedError('build worker', result.status);
	}
}

export async function nativeBuildPost(environment: Environment): Promise<void> {
	await removeJobRoots(environment);
}

class NativeActionSignalError extends CodedError {
	constructor(readonly signal: 'SIGINT' | 'SIGTERM') {
		super(`Build action cancelled by ${signal}`);
		this.name = 'NativeActionSignalError';
	}
	override get exitCode(): number {
		return this.signal === 'SIGINT' ? 130 : 143;
	}
}

class NativePostBuildHookConflictError extends CodedError {
	constructor(existingHook: string) {
		super(
			`The Nix configuration already sets post-build-hook (${existingHook}), ` +
				'and Nix supports exactly one. Remove the existing hook, or set ' +
				'publish: outputs or publish: closure. These modes do not publish ' +
				'observed intermediate outputs.'
		);
		this.name = 'NativePostBuildHookConflictError';
	}
}

export async function runNativeBuild(
	run: (environment: Environment, signal: AbortSignal) => Promise<void>
): Promise<void> {
	const controller = new AbortController();
	const interrupt = (): void => {
		controller.abort(new NativeActionSignalError('SIGINT'));
	};
	const terminate = (): void => {
		controller.abort(new NativeActionSignalError('SIGTERM'));
	};
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', terminate);
	try {
		await run(process.env, controller.signal);
	} catch (error) {
		const failure =
			error instanceof PostBuildHookConflictError
				? new NativePostBuildHookConflictError(error.existingHook)
				: error;
		workflowCommands().error(formatErrorWithCauses(failure));
		process.exitCode = failure instanceof CodedError ? failure.exitCode : 1;
	} finally {
		process.removeListener('SIGINT', interrupt);
		process.removeListener('SIGTERM', terminate);
	}
}
