import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { Nix } from '@cupboard/nix';
import { CodedError } from '@cupboard/shared/errors';
import { z } from 'zod';

import { type Environment, requireEnvironment } from '../inputs.ts';

const execute = promisify(execFile);
// Nix splits build-hook on whitespace without unquoting its arguments.
const temporaryRoot = '/tmp';
const directoryPrefix = 'cupboard-builder-';
export const builderHookStateKey = 'cupboard-builder-hook';

const hookSettingSchema = z.object({ value: z.array(z.string()) });
const configurationSchema = z.object({ 'build-hook': hookSettingSchema });

interface BuilderHookDependencies {
	readonly store?: Pick<Nix, 'storeKind' | 'daemonTrust'>;
	readonly readHook?: () => Promise<readonly string[]>;
}

interface BuilderHook {
	readonly directory: string;
	readonly nixConfig: string;
}

export class BuilderHookTrustError extends CodedError {
	constructor() {
		super(
			'Remote builders require a local store or a trusted local Nix daemon. The daemon must accept the job-specific build-hook setting.'
		);
		this.name = 'BuilderHookTrustError';
	}
}

export class BuilderHookCleanupError extends CodedError {
	constructor() {
		super(
			'The builder hook cleanup path is not a Cupboard invocation directory.'
		);
		this.name = 'BuilderHookCleanupError';
	}
}

class BuilderHookExecutableError extends CodedError {
	constructor(command: string) {
		super(
			`Cannot find an executable for the configured Nix build hook: ${command}`
		);
		this.name = 'BuilderHookExecutableError';
	}
}

class BuilderHookEmptyError extends CodedError {
	constructor() {
		super(
			'The Nix build-hook setting is empty. Enable a build hook to use remote builders.'
		);
		this.name = 'BuilderHookEmptyError';
	}
}

async function readBuildHook(
	environment: Environment
): Promise<readonly string[]> {
	const { stdout } = await execute('nix', ['config', 'show', '--json'], {
		env: { ...environment },
		maxBuffer: 8 * 1024 * 1024
	});
	const configuration: unknown = JSON.parse(stdout);
	return configurationSchema.parse(configuration)['build-hook'].value;
}

async function resolveExecutable(
	command: string,
	environment: Environment
): Promise<string> {
	const candidates = command.includes('/')
		? [path.resolve(command)]
		: (environment.PATH ?? '')
				.split(path.delimiter)
				.map((directory) => path.resolve(directory, command));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			const metadata = await stat(candidate);
			if (metadata.isFile()) {
				return candidate;
			}
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!('code' in error) ||
				!['ENOENT', 'EACCES', 'ENOTDIR'].includes(String(error.code))
			) {
				throw error;
			}
		}
	}
	throw new BuilderHookExecutableError(command);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Wraps the effective build hook with the job's SSH options. The override is
 * passed through NIX_CONFIG to the store connection that performs the build.
 */
export async function prepareBuilderHook(
	environment: Environment,
	dependencies: BuilderHookDependencies = {}
): Promise<BuilderHook> {
	const sshOptions = requireEnvironment(environment, 'NIX_SSHOPTS');
	const store = dependencies.store ?? Nix.open();
	if (
		store.storeKind !== 'local-filesystem' &&
		!(store.storeKind === 'daemon' && (await store.daemonTrust()) === 'trusted')
	) {
		throw new BuilderHookTrustError();
	}
	const [command, ...arguments_] = await (
		dependencies.readHook ?? (() => readBuildHook(environment))
	)();
	if (command === undefined) {
		throw new BuilderHookEmptyError();
	}
	const executable = await resolveExecutable(command, environment);
	const directory = await mkdtemp(path.join(temporaryRoot, directoryPrefix));
	try {
		await chmod(directory, 0o700);
		const hook = path.join(directory, 'build-hook');
		// exec preserves descriptors 4 and 5, which Nix uses for builder output.
		await writeFile(
			hook,
			`#!/bin/sh\nexport NIX_SSHOPTS=${shellQuote(sshOptions)}\nexec ${[executable, ...arguments_].map((argument) => shellQuote(argument)).join(' ')} "$@"\n`,
			{ mode: 0o700 }
		);
		await chmod(hook, 0o700);
		const configuration = environment.NIX_CONFIG ?? '';
		const separator =
			configuration === '' || configuration.endsWith('\n') ? '' : '\n';
		return {
			directory,
			nixConfig: `${configuration}${separator}build-hook = ${hook}\n`
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

/**
 * Removes the adapter after the job's build and publication steps finish.
 */
export async function removeBuilderHook(directory: string): Promise<void> {
	if (
		path.dirname(directory) !== temporaryRoot ||
		!/^cupboard-builder-[\da-z]{6}$/iu.test(path.basename(directory))
	) {
		throw new BuilderHookCleanupError();
	}
	await rm(directory, { recursive: true, force: true });
}
