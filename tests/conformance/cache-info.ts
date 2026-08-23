import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { UnreachableSubstituter } from '../../packages/nix/src/nix-store.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';

import {
	askClient,
	fixtureNarinfoFile,
	fixtureStorePath,
	narinfoDocument,
	type OfferFields,
	oracleOffer,
	pathInfoArguments
} from './narinfo.ts';
import type { Oracle } from './oracle.ts';

export type CacheFixture = {
	readonly parameters?: string;
} & (
	| {
			readonly kind: 'directory';
			readonly cacheInfo?: string;
	  }
	| { readonly kind: 'file' }
);

export interface CacheOutcome {
	readonly oracle: {
		readonly opened: boolean;
		readonly offer: OfferFields | undefined;
		readonly stderr: string;
	};
	readonly client: {
		readonly uri: string;
		readonly offer: OfferFields | undefined;
		readonly unreachable: readonly UnreachableSubstituter[];
	};
}

async function writeCache(
	cachePath: string,
	fixture: CacheFixture
): Promise<string> {
	if (fixture.kind === 'file') {
		await writeFile(cachePath, '');

		return cachePath;
	}

	await mkdir(cachePath, { recursive: true });
	await writeFile(
		path.join(cachePath, fixtureNarinfoFile),
		narinfoDocument({})
	);

	if (fixture.cacheInfo !== undefined) {
		await writeFile(path.join(cachePath, 'nix-cache-info'), fixture.cacheInfo);
	}

	return cachePath;
}

/**
 * Presents equivalent cache directories to both clients and queries the
 * fixture path.
 *
 * Each client receives a separate copy because Nix writes a default
 * `nix-cache-info` when a cache does not provide one. With a shared directory,
 * our client could read the file written by Nix instead of the fixture state.
 */
export async function openCache(
	oracle: Oracle,
	fixture: CacheFixture
): Promise<CacheOutcome> {
	return withTemporaryDirectory(
		'cupboard-conformance-cache-info-',
		async (home) => {
			const environment = await isolatedEnvironment(home);
			const forOracle = await writeCache(path.join(home, 'oracle'), fixture);
			const forClient = await writeCache(path.join(home, 'client'), fixture);

			const parameters = fixture.parameters ?? '';
			const shown = await oracle.run(
				pathInfoArguments(`${forOracle}${parameters}`, fixtureStorePath),
				{ env: environment }
			);
			const client = await askClient(forClient, parameters);

			return {
				oracle: {
					opened: shown.status === 0,
					offer:
						shown.status === 0
							? oracleOffer(shown.stdout, fixtureStorePath)
							: undefined,
					stderr: shown.stderr
				},
				client: { uri: `file://${forClient}${parameters}`, ...client }
			};
		}
	);
}
