import type { Reporter } from '@cupboard/reporter';

import type { ResolvedCupboard } from './cupboard-resolution.ts';
import type { Environment } from './inputs.ts';
import { installCupboard } from './release-install.ts';
import { acquireSourceCupboard } from './source-install.ts';

export interface AcquireCupboardOptions {
	readonly cupboard: ResolvedCupboard;
	readonly installDirectory: string;
	readonly checkoutDirectory: string;
	readonly githubToken: string;
	readonly environment: Environment;
}

export interface AcquiredCupboard {
	readonly binaryPath: string;
	readonly cupboard: ResolvedCupboard;
}

interface AcquireCupboardDependencies {
	readonly installRelease: typeof installCupboard;
	readonly installSource: typeof acquireSourceCupboard;
}

const defaultDependencies: AcquireCupboardDependencies = {
	installRelease: installCupboard,
	installSource: acquireSourceCupboard
};

/** Acquire exactly one already-resolved release or source coordinate. */
export async function acquireCupboard(
	options: AcquireCupboardOptions,
	reporter: Reporter,
	dependencies: AcquireCupboardDependencies = defaultDependencies
): Promise<AcquiredCupboard> {
	if (options.cupboard.kind === 'source') {
		return dependencies.installSource({
			checkoutDirectory: options.checkoutDirectory,
			cupboard: options.cupboard
		});
	}

	const installed = await dependencies.installRelease(
		{
			installDirectory: options.installDirectory,
			releaseRepository: options.cupboard.repository,
			version: options.cupboard.tag,
			includePrereleases: true,
			githubToken: options.githubToken,
			environment: options.environment,
			expectedSourceCommit: options.cupboard.sourceCommit
		},
		reporter
	);

	return { binaryPath: installed.binaryPath, cupboard: options.cupboard };
}
