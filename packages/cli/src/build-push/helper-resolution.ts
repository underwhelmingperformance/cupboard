import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { HookHelperMissingError } from '../errors.ts';

export const hookHelperName = 'cupboard-hook-relay';

export interface HelperResolutionOptions {
	readonly executablePath?: string;
}

async function isFile(candidate: string): Promise<boolean> {
	try {
		const stats = await stat(candidate);

		return stats.isFile();
	} catch {
		return false;
	}
}

/**
 * The absolute path of the compiled hook helper, resolved from this
 * installation itself: resolution evaluates nothing, runs no subprocess and
 * depends on no substituter. The release tarball unpacks the helper beside
 * the `cupboard` executable, and the Nix package installs it under the
 * sibling `libexec/cupboard/` directory. Preflight calls this before the
 * expensive build starts, so an installation missing its helper refuses early.
 */
export async function resolveHookHelper(
	options: HelperResolutionOptions = {}
): Promise<string> {
	const executablePath = options.executablePath ?? process.execPath;
	const executableDirectory = path.dirname(
		await canonicalExecutablePath(executablePath)
	);
	const candidates = [
		path.join(executableDirectory, hookHelperName),
		path.join(executableDirectory, '..', 'libexec', 'cupboard', hookHelperName)
	];

	for (const candidate of candidates) {
		if (await isFile(candidate)) {
			return candidate;
		}
	}

	throw new HookHelperMissingError(candidates);
}

async function canonicalExecutablePath(
	executablePath: string
): Promise<string> {
	try {
		return await realpath(executablePath);
	} catch {
		// Preserve the complete candidate diagnostic for an absent executable.
		return executablePath;
	}
}
