import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { byCodeUnit } from '@cupboard/nix-store/store-path';

import { runCommand } from './process.ts';

/** A cupboard installation unpacked from a release archive. */
export interface ReleaseInstallation {
	/** The `cupboard-path` input an action receives. */
	readonly commandPath: string;
	/** Every member of the archive, in a stable order. */
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
