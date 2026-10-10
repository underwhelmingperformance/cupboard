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
	readonly signal?: AbortSignal;
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

/**
 * Acquire only the resolved coordinate. A release installation failure must
 * fail the action; it must not trigger a source build.
 */
export async function acquireCupboard(
	options: AcquireCupboardOptions,
	reporter: Reporter,
	dependencies: AcquireCupboardDependencies = defaultDependencies
): Promise<AcquiredCupboard> {
	if (options.cupboard.kind === 'source') {
		const cupboard = options.cupboard;
		return reporter.phase('Building cupboard from source', async () => {
			const acquired = await dependencies.installSource({
				checkoutDirectory: options.checkoutDirectory,
				installDirectory: options.installDirectory,
				cupboard,
				...(options.signal !== undefined && { signal: options.signal })
			});
			reporter.info(
				`Installed cupboard from ${cupboard.repository}@${cupboard.sourceCommit}`
			);
			return acquired;
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
			expectedSourceCommit: options.cupboard.sourceCommit,
			...(options.signal !== undefined && { signal: options.signal })
		},
		reporter
	);

	return { binaryPath: installed.binaryPath, cupboard: options.cupboard };
}
