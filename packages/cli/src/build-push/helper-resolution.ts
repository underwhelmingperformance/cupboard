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
 * Finds the compiled hook helper in either supported installation layout. A
 * release archive places it beside `cupboard`; the Nix package places it under
 * the sibling `libexec/cupboard` directory. Resolution performs no evaluation
 * or substitution, so preflight can reject an incomplete installation before
 * starting the build.
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
