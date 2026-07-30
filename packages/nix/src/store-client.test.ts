import { storeDirectorySchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { NixDaemonStoreClient } from './nix-daemon.ts';
import { NixLocalStoreClient } from './nix-local-store.ts';
import { UnsupportedNixStoreError } from './nix-store.ts';
import {
	createNixStoreClient,
	resolveStoreBackend,
	type StoreBackend,
	type StoreClientEnvironment
} from './store-client.ts';
import type { NixStoreConfig } from './store-config.ts';

const baseConfig: NixStoreConfig = {
	storeUri: 'auto',
	storeDirectory: storeDirectorySchema.parse('/nix/store'),
	stateDirectory: '/nix/var/nix',
	daemonSocketPath: '/nix/var/nix/daemon-socket/socket',
	daemonSetOptions: {},
	daemonOverrides: {}
};

interface Probes {
	readonly canWrite?: boolean;
	readonly socket?: boolean;
}

function resolve(storeUri: string, probes: Probes = {}): StoreBackend {
	return resolveStoreBackend(
		{ ...baseConfig, storeUri },
		{
			canWriteStateDirectory: () => probes.canWrite ?? false,
			socketExists: () => probes.socket ?? false
		}
	);
}

const noFiles = new Map<string, string>();

function environment(env: Record<string, string>): StoreClientEnvironment {
	return {
		env,
		readFile: (filePath) => noFiles.get(filePath),
		homeDirectory: () => noFiles.get('home'),
		canWriteStateDirectory: () => false,
		socketExists: () => true
	};
}

describe('resolveStoreBackend', () => {
	const daemon: StoreBackend = {
		backend: 'daemon',
		socketPath: '/nix/var/nix/daemon-socket/socket'
	};
	const local: StoreBackend = {
		backend: 'local',
		stateDirectory: '/nix/var/nix'
	};

	it.each([
		{ name: 'daemon', uri: 'daemon', probes: {}, expected: daemon },
		{ name: 'local', uri: 'local', probes: {}, expected: local },
		{ name: 'empty', uri: '', probes: {}, expected: local },
		{
			name: 'auto with a writable state directory',
			uri: 'auto',
			probes: { canWrite: true, socket: true },
			expected: local
		},
		{
			name: 'auto with a read-only state directory and a socket',
			uri: 'auto',
			probes: { canWrite: false, socket: true },
			expected: daemon
		},
		{
			name: 'auto with a read-only state directory and no socket',
			uri: 'auto',
			probes: { canWrite: false, socket: false },
			expected: local
		},
		{
			name: 'a unix socket URI',
			uri: 'unix:///run/nix.sock',
			probes: {},
			expected: { backend: 'daemon', socketPath: '/run/nix.sock' }
		},
		{
			name: 'a bare unix scheme',
			uri: 'unix://',
			probes: {},
			expected: daemon
		}
	])('selects $name', ({ uri, probes, expected }) => {
		expect(resolve(uri, probes)).toStrictEqual(expected);
	});

	it('rejects an unsupported store scheme', () => {
		expect(() => resolve('ssh://builder')).toThrow(UnsupportedNixStoreError);
	});
});

describe('createNixStoreClient', () => {
	it('builds a daemon client for a daemon store', () => {
		expect(
			createNixStoreClient(environment({ NIX_REMOTE: 'daemon' }))
		).toBeInstanceOf(NixDaemonStoreClient);
	});

	it('builds a local client for a local store', () => {
		expect(
			createNixStoreClient(environment({ NIX_REMOTE: 'local' }))
		).toBeInstanceOf(NixLocalStoreClient);
	});
});
