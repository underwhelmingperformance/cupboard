import { readFile } from 'node:fs/promises';
import { env } from 'node:process';

import { Nix, probePublicObject, type PublicObjectAccess } from '@cupboard/nix';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import {
	type FlakeInputSourceDependencies,
	type FlakeInputSources,
	selectFlakeInputSources
} from '../flake-input-sources.ts';
import { type Environment, setOutput } from '../inputs.ts';
import { copyNixPaths, type NixCopyOptions } from '../nix-copy.ts';

export interface FlakeInputCacheOptions {
	readonly directory: string;
	readonly flakeLock: string;
}

type ProbeOptions = Parameters<typeof probePublicObject>[1];

export interface FlakeInputCacheDependencies extends Partial<FlakeInputSourceDependencies> {
	readonly reporter?: Reporter;
	readonly copy?: (
		options: NixCopyOptions,
		signal: AbortSignal | undefined
	) => Promise<void>;
	/**
	The fetch that origin requests use when `probeOrigin` is not given.
	*/
	readonly fetch?: ProbeOptions['fetch'];
	/**
	Creates the signal that ends one origin request. Production requests end
	after `originRequestTimeoutMs`.
	*/
	readonly originDeadline?: () => AbortSignal;
}

const originRequestTimeoutMs = 30_000;

export function registerFlakeInputCacheCommand(
	program: Command,
	environment: Environment = env,
	signal?: AbortSignal
): void {
	program
		.command('flake-input-cache')
		.description(
			'Copy the public flake input sources that this job fetched into a local binary cache.'
		)
		.requiredOption('--directory <path>', 'directory of the binary cache')
		.option('--flake-lock <path>', 'the flake.lock to read', 'flake.lock')
		.action((options: FlakeInputCacheOptions) =>
			flakeInputCacheAction(options, environment, signal)
		);
}

/**
Copies the source paths that `selectFlakeInputSources` selects into a binary
cache at `options.directory`, and sets the `save` output to `true` when the
cache is complete and has contents. A failure produces a warning and sets
`save` to `false`, so it never fails the job.
*/
export async function flakeInputCacheAction(
	options: FlakeInputCacheOptions,
	environment: Environment = env,
	signal?: AbortSignal,
	dependencies: FlakeInputCacheDependencies = {}
): Promise<void> {
	const reporter =
		dependencies.reporter ?? createGithubReporter({ environment });

	try {
		const isSaved = await hasFilledFlakeInputCache(
			options,
			signal,
			dependencies,
			reporter
		);
		await setOutput(environment, 'save', String(isSaved));
	} catch (error) {
		signal?.throwIfAborted();
		reporter.warn(
			'Not caching flake input sources',
			error instanceof Error ? error.message : String(error)
		);
		await setOutput(environment, 'save', 'false');
	}
}

// Fills the cache directory and returns whether the cache should be saved.
async function hasFilledFlakeInputCache(
	options: FlakeInputCacheOptions,
	signal: AbortSignal | undefined,
	dependencies: FlakeInputCacheDependencies,
	reporter: Reporter
): Promise<boolean> {
	const lockText = await readLock(options.flakeLock);

	if (lockText === undefined) {
		reporter.info(
			`No ${options.flakeLock}, so no flake input sources to cache`
		);

		return false;
	}

	const originDeadline =
		dependencies.originDeadline ??
		(() => AbortSignal.timeout(originRequestTimeoutMs));
	const selection = await selectFlakeInputSources(JSON.parse(lockText), {
		nix: dependencies.nix ?? Nix.open(),
		probeOrigin:
			dependencies.probeOrigin ??
			((url) => probeOrigin(url, signal, originDeadline(), dependencies.fetch))
	});

	reportSkippedInputs(selection, reporter);

	const unavailable = inputsSkippedFor(selection, 'unavailable');

	// The key covers the whole lock, and a run that restores the cache does not
	// collect again. Saving without these sources would keep them out of the
	// cache until the lock changes, so a later run retries instead.
	if (unavailable.length > 0) {
		reporter.warn(
			'Not saving the flake input cache',
			`no definite answer from the origin of ${unavailable.join(', ')}; a later run retries`
		);

		return false;
	}

	if (selection.paths.length === 0) {
		reporter.info('No public flake input sources to cache');

		return false;
	}

	await (dependencies.copy ?? copyNixPaths)(
		{
			paths: selection.paths,
			to: `file://${options.directory}?compression=none`,
			quiet: true
		},
		signal
	);
	reporter.info(
		`Cached ${String(selection.paths.length)} public flake input sources`
	);

	return true;
}

function inputsSkippedFor(
	selection: FlakeInputSources,
	reason: FlakeInputSources['skipped'][number]['reason']
): readonly string[] {
	return selection.skipped
		.filter((skipped) => skipped.reason === reason)
		.map((skipped) => skipped.input);
}

function reportSkippedInputs(
	selection: FlakeInputSources,
	reporter: Reporter
): void {
	for (const input of inputsSkippedFor(selection, 'malformed')) {
		reporter.warn(
			'Leaving a flake input out of the cache',
			`the flake.lock entry for ${input} is not a valid locked input`
		);
	}

	for (const { input, collidesWith } of selection.skipped) {
		if (collidesWith === undefined) {
			continue;
		}

		const origin =
			collidesWith.origin === undefined ? '' : ` (${collidesWith.origin})`;

		reporter.warn(
			'Leaving a flake input out of the cache',
			`${collidesWith.input}${origin}, which is not a cache candidate, locks the same source path as ${input}`
		);
	}

	const otherOrigins = inputsSkippedFor(selection, 'origin');

	if (otherOrigins.length > 0) {
		reporter.info(
			`Left out ${String(otherOrigins.length)} flake inputs whose origin is not an HTTPS github.com URL without a query string, because the runner cannot prove that such an origin is public: ${otherOrigins.join(', ')}`
		);
	}
}

async function readLock(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, 'utf8');
	} catch (error) {
		if (isMissingFile(error)) {
			return undefined;
		}

		throw error;
	}
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

// A request that reaches its deadline has no definite answer. Only an abort of
// the job's own signal stops the selection.
async function probeOrigin(
	url: URL,
	signal: AbortSignal | undefined,
	deadline: AbortSignal,
	fetch: ProbeOptions['fetch']
): Promise<PublicObjectAccess> {
	try {
		return await probePublicObject(url, {
			signal:
				signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
			...(fetch !== undefined && { fetch })
		});
	} catch (error) {
		signal?.throwIfAborted();

		if (deadline.aborted) {
			return 'unavailable';
		}

		throw error;
	}
}
