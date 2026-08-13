import {
	storeDirectorySchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { FakeDaemonTransport } from '../../../tests/support/fake-daemon-transport.ts';

import { NixDaemonStoreClient } from './nix-daemon.ts';
import { NixLocalStoreClient } from './nix-local-store.ts';
import {
	NixDaemonUnavailableError,
	UnsupportedNixStoreError
} from './nix-store.ts';
import {
	createNixDaemonStoreClient,
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
	daemonOverrides: {},
	substitution: {
		substitute: true,
		alwaysAllowSubstitutes: false,
		substituters: ['https://cache.nixos.org/']
	},
	building: { systems: ['x86_64-linux'], features: [] }
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
		currentSystem: () => 'x86_64-linux',
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
		stateDirectory: '/nix/var/nix',
		storeDirectory: storeDirectorySchema.parse('/nix/store')
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
		},
		{
			name: 'an ssh-ng store',
			uri: 'ssh-ng://build@example.test',
			probes: {},
			expected: {
				backend: 'ssh-ng',
				remote: { destination: 'build@example.test' }
			}
		},
		{
			name: 'an ssh-ng store naming its remote program',
			uri: 'ssh-ng://example.test?remote-program=/opt/nix/bin/nix-daemon',
			probes: {},
			expected: {
				backend: 'ssh-ng',
				remote: {
					destination: 'example.test',
					remoteProgram: '/opt/nix/bin/nix-daemon'
				}
			}
		}
	])('selects $name', ({ uri, probes, expected }) => {
		expect(resolve(uri, probes)).toStrictEqual(expected);
	});

	it.each([
		{ name: 'an unsupported scheme', uri: 'ssh://builder' },
		{ name: 'an ssh-ng store with no destination', uri: 'ssh-ng://' }
	])('rejects $name', ({ uri }) => {
		expect(() => resolve(uri)).toThrow(UnsupportedNixStoreError);
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

	it('builds a daemon client for an ssh-ng store', () => {
		expect(
			createNixStoreClient(
				environment({ NIX_REMOTE: 'ssh-ng://build@example.test' })
			)
		).toBeInstanceOf(NixDaemonStoreClient);
	});
});

function daemonEnvironment(probes: Probes): StoreClientEnvironment {
	return {
		env: {},
		readFile: (filePath) => noFiles.get(filePath),
		homeDirectory: () => noFiles.get('home'),
		currentSystem: () => 'x86_64-linux',
		canWriteStateDirectory: () => probes.canWrite ?? false,
		socketExists: () => probes.socket ?? false
	};
}

describe('createNixDaemonStoreClient', () => {
	it.each([
		{ name: 'a writable state directory', canWrite: true },
		{ name: 'a read-only state directory', canWrite: false }
	])('selects the daemon over $name when its socket exists', ({ canWrite }) => {
		expect(
			createNixDaemonStoreClient(daemonEnvironment({ canWrite, socket: true }))
		).toBeInstanceOf(NixDaemonStoreClient);
	});

	it.each([
		{ name: 'a writable state directory', canWrite: true },
		{ name: 'a read-only state directory', canWrite: false }
	])('refuses a daemonless install with $name', ({ canWrite }) => {
		let outcome:
			| { value: NixDaemonStoreClient }
			| { error: { name: string; socketPath: string } };
		try {
			const value = createNixDaemonStoreClient(
				daemonEnvironment({ canWrite, socket: false })
			);
			outcome = { value };
		} catch (error_: unknown) {
			expect(error_).toBeInstanceOf(NixDaemonUnavailableError);

			if (!(error_ instanceof NixDaemonUnavailableError)) {
				throw error_;
			}

			outcome = {
				error: { name: error_.name, socketPath: error_.socketPath }
			};
		}

		expect(outcome).toStrictEqual({
			error: {
				name: 'NixDaemonUnavailableError',
				socketPath: '/nix/var/nix/daemon-socket/socket'
			}
		});
	});

	it('probes the socket a unix store URI names', () => {
		let outcome:
			{ value: NixDaemonStoreClient } | { error: { socketPath: string } };
		try {
			const value = createNixDaemonStoreClient(
				daemonEnvironment({ canWrite: true, socket: false }),
				{ ...baseConfig, storeUri: 'unix:///run/nix.sock' }
			);
			outcome = { value };
		} catch (error_: unknown) {
			if (!(error_ instanceof NixDaemonUnavailableError)) {
				throw error_;
			}

			outcome = { error: { socketPath: error_.socketPath } };
		}

		expect(outcome).toStrictEqual({
			error: { socketPath: '/run/nix.sock' }
		});
	});

	it('opens an ssh-ng store without probing a local socket', async () => {
		const storePath = storePathSchema.parse(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
		);
		const client = createNixDaemonStoreClient(
			daemonEnvironment({ socket: false }),
			{ ...baseConfig, storeUri: 'ssh-ng://build@example.test' },
			{
				connect: () =>
					Promise.resolve(
						new FakeDaemonTransport({
							[storePath]: {
								hash: '11'.repeat(32),
								narSize: 123,
								references: [],
								signatures: []
							}
						})
					)
			}
		);

		await expect(client.queryValidPaths([storePath])).resolves.toStrictEqual([
			storePath
		]);
	});

	it('opens the ssh-ng store a per-call storeUri names over a local configuration', async () => {
		const storePath = storePathSchema.parse(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
		);
		const client = createNixDaemonStoreClient(
			daemonEnvironment({ socket: false }),
			baseConfig,
			{
				storeUri: 'ssh-ng://build@example.test',
				connect: () =>
					Promise.resolve(
						new FakeDaemonTransport({
							[storePath]: {
								hash: '11'.repeat(32),
								narSize: 123,
								references: [],
								signatures: []
							}
						})
					)
			}
		);

		await expect(client.queryValidPaths([storePath])).resolves.toStrictEqual([
			storePath
		]);
	});

	it('merges per-call options over the discovered daemon settings', async () => {
		const storePath = storePathSchema.parse(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
		);
		const config: NixStoreConfig = {
			...baseConfig,
			daemonSetOptions: { maxBuildJobs: 1, keepGoing: true },
			daemonOverrides: {
				'netrc-file': '/discovered/netrc',
				'download-attempts': '2'
			}
		};
		const client = createNixDaemonStoreClient(
			daemonEnvironment({ socket: true }),
			config,
			{
				setOptions: { maxBuildJobs: 4 },
				overrides: { 'netrc-file': '/caller/netrc' },
				connect: () =>
					Promise.resolve(
						new FakeDaemonTransport(
							{
								[storePath]: {
									hash: '11'.repeat(32),
									narSize: 123,
									references: [],
									signatures: []
								}
							},
							{
								expectedSetOptions: {
									keepFailed: false,
									keepGoing: true,
									tryFallback: false,
									maxBuildJobs: 4,
									maxSilentTime: 0,
									buildCores: 0,
									useSubstitutes: true
								},
								expectedOverrides: {
									'netrc-file': '/caller/netrc',
									'download-attempts': '2'
								}
							}
						)
					)
			}
		);

		await expect(client.queryValidPaths([storePath])).resolves.toStrictEqual([
			storePath
		]);
	});
});
