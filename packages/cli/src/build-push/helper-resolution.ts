import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { HookHelperMissingError } from '../errors.ts';

export const hookHelperName = 'cupboard-hook-relay';

export interface HelperResolutionEnvironment {
	readonly CUPBOARD_HOOK_HELPER?: string;
}

export interface HelperResolutionOptions {
	readonly environment?: HelperResolutionEnvironment;
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
 * sibling `libexec/cupboard/` directory; `CUPBOARD_HOOK_HELPER` names an
 * explicit helper for development. Preflight calls this before the expensive
 * build starts, so an installation missing its helper refuses early.
 */
export async function resolveHookHelper(
	options: HelperResolutionOptions = {}
): Promise<string> {
	const environment = options.environment ?? process.env;
	const override = environment.CUPBOARD_HOOK_HELPER;

	if (override !== undefined && override !== '') {
		if (await isFile(override)) {
			return override;
		}

		throw new HookHelperMissingError([override]);
	}

	const executableDirectory = path.dirname(
		options.executablePath ?? process.execPath
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
