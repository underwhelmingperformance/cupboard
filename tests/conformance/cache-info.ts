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

/** One cache for both sides to open, as it sits on disk. */
export type CacheFixture = {
	/** The store URI parameters both sides configure the cache with. */
	readonly parameters?: string;
} & (
	| {
			readonly kind: 'directory';
			/** The `nix-cache-info` the cache serves, or absent to serve none. */
			readonly cacheInfo?: string;
	  }
	/** A store URI naming a regular file, which has no cache under it at all. */
	| { readonly kind: 'file' }
);

/** What one side made of the cache directory. */
export interface CacheOutcome {
	readonly oracle: {
		/** Whether nix opened the cache and answered about the path. */
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
 * Puts one cache directory to both sides and asks each about the fixture path.
 *
 * Each side reads its own copy of the fixture, because opening a directory
 * cache writes into it: nix gives one serving no `nix-cache-info` the document
 * it lacks, so a shared cache would have our client read what nix left rather
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
