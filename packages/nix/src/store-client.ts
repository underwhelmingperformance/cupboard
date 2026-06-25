import { accessSync, constants, existsSync } from 'node:fs';

import { NixDaemonStoreClient } from './nix-daemon.ts';
import {
	NixLocalStoreClient,
	openLocalStoreDatabase
} from './nix-local-store.ts';
import { type NixStoreClient, UnsupportedNixStoreError } from './nix-store.ts';
import {
	defaultNixConfigEnvironment,
	discoverNixStoreConfig,
	type NixConfigEnvironment,
	type NixStoreConfig
} from './store-config.ts';

/** Probes Nix uses to resolve an `auto` store, injected so selection is testable. */
export interface StoreClientEnvironment extends NixConfigEnvironment {
	/** Whether the state directory is readable and writable by this process. */
	canWriteStateDirectory(stateDirectory: string): boolean;
	socketExists(socketPath: string): boolean;
}

export const defaultStoreClientEnvironment: StoreClientEnvironment = {
	...defaultNixConfigEnvironment,
	canWriteStateDirectory: (stateDirectory) => {
		try {
			accessSync(stateDirectory, constants.R_OK | constants.W_OK);

			return true;
		} catch {
			return false;
		}
	},
	socketExists: (socketPath) => existsSync(socketPath)
};

export type StoreBackend =
	| { readonly backend: 'daemon'; readonly socketPath: string }
	| { readonly backend: 'local'; readonly stateDirectory: string };

const unixScheme = 'unix://';

/**
 * Open the Nix store the running configuration points at, the way the C++ client
 * resolves a store reference: the daemon for a `daemon`/`unix://` store, the
 * local store for `local`, and for `auto` the same choice Nix makes, preferring
 * the local store when the state directory is writable and otherwise the daemon.
 */
export function createNixStoreClient(
	dependencies: StoreClientEnvironment = defaultStoreClientEnvironment,
	config: NixStoreConfig = discoverNixStoreConfig(dependencies)
): NixStoreClient {
	const backend = resolveStoreBackend(config, dependencies);

	if (backend.backend === 'daemon') {
		return new NixDaemonStoreClient({ socketPath: backend.socketPath });
	}

	return new NixLocalStoreClient(() =>
		openLocalStoreDatabase(backend.stateDirectory)
	);
}

interface StoreBackendProbes {
	canWriteStateDirectory(stateDirectory: string): boolean;
	socketExists(socketPath: string): boolean;
}

export function resolveStoreBackend(
	config: NixStoreConfig,
	probes: StoreBackendProbes
): StoreBackend {
	const uri = config.storeUri;

	if (uri === 'daemon') {
		return { backend: 'daemon', socketPath: config.daemonSocketPath };
	}

	if (uri === 'local' || uri === '') {
		return { backend: 'local', stateDirectory: config.stateDirectory };
	}

	if (uri === 'auto') {
		return resolveAuto(config, probes);
	}

	if (uri.startsWith(unixScheme)) {
		return {
			backend: 'daemon',
			socketPath: unixSocketPath(uri) ?? config.daemonSocketPath
		};
	}

	throw new UnsupportedNixStoreError(uri);
}

// Nix's `auto`: use the local store when this process can read and write the
// state directory, else the daemon when its socket is present, else fall back to
// the local store.
function resolveAuto(
	config: NixStoreConfig,
	probes: StoreBackendProbes
): StoreBackend {
	if (probes.canWriteStateDirectory(config.stateDirectory)) {
		return { backend: 'local', stateDirectory: config.stateDirectory };
	}

	if (probes.socketExists(config.daemonSocketPath)) {
		return { backend: 'daemon', socketPath: config.daemonSocketPath };
	}

	return { backend: 'local', stateDirectory: config.stateDirectory };
}

function unixSocketPath(uri: string): string | undefined {
	const [socket] = uri.slice(unixScheme.length).split('?');

	return socket === undefined || socket === '' ? undefined : socket;
}
