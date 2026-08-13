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

/** The on-disk cache fixture opened by both clients. */
export type CacheFixture = {
	/** The store URI parameters both sides configure the cache with. */
	readonly parameters?: string;
} & (
	| {
			readonly kind: 'directory';
			/** The served `nix-cache-info`, or `undefined` to omit it. */
			readonly cacheInfo?: string;
	  }
	/** A store URI naming a regular file, which has no cache under it at all. */
	| { readonly kind: 'file' }
);

/** One client's result for the cache directory. */
export interface CacheOutcome {
	readonly oracle: {
		/** Whether Nix opened the cache and queried the path. */
		readonly opened: boolean;
		readonly offer: OfferFields | undefined;
		/** Why nix refused to open it, for a case that reports the refusal. */
		readonly stderr: string;
	};
	readonly client: {
		/** The cache as our client was configured with it. */
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
 * Presents equivalent cache directories to both clients and queries the fixture path.
 *
 * Each side reads its own copy of the fixture, because opening a directory
 * cache writes into it: nix gives one serving no `nix-cache-info` the document
 * it lacks, so a shared directory would let our client read what Nix wrote rather
 * than what the case set up.
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
