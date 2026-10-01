import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { byCodeUnit } from '@cupboard/nix-store/store-path';

import { releaseAssetNameFor } from '../../scripts/build-cupboard-binary.ts';

import { runCommand } from './process.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Builds this checkout's executable and hook helper as a release archive for
 * the current platform, using the release build script.
 */
export async function buildReleaseArchive(options: {
	readonly directory: string;
	readonly env?: NodeJS.ProcessEnv;
}): Promise<string> {
	await runCommand(
		process.execPath,
		[
			'--experimental-transform-types',
			'--disable-warning=ExperimentalWarning',
			'scripts/build-cupboard-binary.ts',
			'--version',
			'v0.0.0-ci',
			'--out-dir',
			options.directory
		],
		{ cwd: repositoryRoot, env: options.env }
	);

	return path.join(
		options.directory,
		releaseAssetNameFor(process.platform, process.arch)
	);
}

/**
A cupboard installation unpacked from a release archive.
*/
export interface ReleaseInstallation {
	/**
	The `cupboard-path` input an action receives.
	*/
	readonly commandPath: string;
	/**
	Every member of the archive, in a stable order.
	*/
	readonly entries: readonly string[];
}

/**
 * Unpacks a release archive the way `actions/setup` unpacks one on a runner:
 * the `cupboard` executable and its hook helper side by side in one
 * directory. The caller passes the archive `pnpm build:binary` wrote for this
 * platform.
 */
export async function unpackReleaseArchive(options: {
	readonly archivePath: string;
	readonly directory: string;
}): Promise<ReleaseInstallation> {
	await mkdir(options.directory, { recursive: true });
	await runCommand('tar', [
		'-xzf',
		options.archivePath,
		'-C',
		options.directory
	]);
	const listing = await runCommand('tar', ['-tzf', options.archivePath]);

	return {
		commandPath: path.join(options.directory, 'cupboard'),
		entries: listing.stdout
			.split('\n')
			.filter((entry) => entry !== '')
			.toSorted(byCodeUnit)
	};
}
