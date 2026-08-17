import path from 'node:path';

import { expect, it } from 'vitest';

import { describeConformance } from './oracle.ts';
import {
	chrootFallbackUnavailable,
	resolvedStores,
	type StoreEnvironment
} from './store-resolution.ts';

describeConformance('the store selected by a configuration', (oracle) => {
	// Exact: both sides read one environment and select one store.
	it.for<{ name: string; environment: StoreEnvironment }>([
		{
			// The machine's own filesystem decides this one: whether its state
			// directory can be written and whether a daemon is listening. Neither
			// side is told which result to expect, so both must derive it from the
			// same host state.
			name: "the store selected from this machine's state",
			environment: () => ({})
		},
		{
			name: 'a store setting set to the daemon',
			environment: () => ({ NIX_CONFIG: 'store = daemon' })
		},
		{
			name: 'a store setting set to a daemon socket',
			environment: ({ socketPath }) => ({
				NIX_CONFIG: `store = unix://${socketPath}`
			})
		},
		{
			name: 'a store setting set to the local store',
			environment: ({ storeDirectory, stateDirectory }) => ({
				NIX_CONFIG: 'store = local',
				NIX_STORE_DIR: storeDirectory,
				NIX_STATE_DIR: stateDirectory
			})
		},
		{
			name: 'directories of its own and no store setting',
			environment: ({ storeDirectory, stateDirectory }) => ({
				NIX_STORE_DIR: storeDirectory,
				NIX_STATE_DIR: stateDirectory
			})
		},
		{
			name: 'NIX_REMOTE set to the daemon',
			environment: () => ({ NIX_REMOTE: 'daemon' })
		},
		{
			name: 'an empty NIX_REMOTE with explicit store directories',
			environment: ({ storeDirectory, stateDirectory }) => ({
				NIX_REMOTE: '',
				NIX_STORE_DIR: storeDirectory,
				NIX_STATE_DIR: stateDirectory
			})
		},
		{
			// A store setting wins over NIX_REMOTE, which is only the value the
			// setting starts at.
			name: 'a store setting that overrides NIX_REMOTE',
			environment: ({ storeDirectory, stateDirectory }) => ({
				NIX_REMOTE: 'daemon',
				NIX_CONFIG: 'store = local',
				NIX_STORE_DIR: storeDirectory,
				NIX_STATE_DIR: stateDirectory
			})
		},
		{
			// A local store configures its own directories: this one puts the store
			// and the state under a root of its own.
			name: 'a local store under a root of its own',
			environment: ({ home }) => ({
				NIX_CONFIG: `store = local?root=${path.join(home, 'rooted')}`
			})
		},
		{
			name: 'a local store with explicit store and state directories',
			environment: ({ storeDirectory, stateDirectory }) => ({
				NIX_CONFIG: `store = local?store=${storeDirectory}&state=${stateDirectory}`
			})
		},
		{
			// A path refers to a local store rooted at that path.
			name: 'a store setting containing a path',
			environment: ({ home }) => ({
				NIX_CONFIG: `store = ${path.join(home, 'rooted')}`
			})
		},
		{
			name: 'a store setting containing a local URI',
			environment: ({ home }) => ({
				NIX_CONFIG: `store = local://${path.join(home, 'rooted')}`
			})
		}
	])(
		'selects the same store as Nix for $name',
		async ({ environment }, context) => {
			const selected = await resolvedStores(oracle, environment);

			await context.annotate(selected.url, 'Store URL reported by Nix');

			expect({ kind: selected.client.kind }).toStrictEqual({
				kind: selected.oracle.kind
			});
		}
	);

	// The store Nix falls back to for a machine with no Nix directories of its
	// own. Every machine this suite runs on has them, so the case reports why it
	// could not be exercised rather than passing.
	it('selects the same fallback store as Nix', async (context) => {
		const unavailable = chrootFallbackUnavailable(oracle.system);

		if (unavailable !== undefined) {
			context.skip(unavailable);
		}

		const selected = await resolvedStores(oracle, ({ dataHome }) => ({
			NIX_DATA_HOME: dataHome
		}));

		await context.annotate(selected.url, 'Store URL reported by Nix');

		expect({ kind: selected.client.kind }).toStrictEqual({
			kind: selected.oracle.kind
		});
	});
});
