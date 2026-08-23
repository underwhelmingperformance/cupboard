import {
	storeDirectorySchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { FakeDaemonTransport } from '../../../tests/support/fake-daemon-transport.ts';

import { NixDaemonStoreClient } from './nix-daemon.ts';
import { NixLocalStoreClient } from './nix-local-store.ts';
import {
	InvalidNixStoreParameterError,
	NixConfigSettingError,
	NixDaemonUnavailableError,
	type NixDerivedPathString,
	type NixStoreClient,
	UnsupportedNixStoreError
} from './nix-store.ts';
import {
	type AvailabilityStore,
	createAvailabilityStoreClient,
	createNixDaemonStoreClient,
	createNixStoreClient,
	type NixDaemonClientOptions,
	overriddenSubstitution,
	resolveStoreBackend,
	type StoreBackend,
	type StoreClientEnvironment
} from './store-client.ts';
import {
	defaultFileTransferSettings,
	defaultSignatureSettings,
	type NixDaemonOverrides,
	type NixMachineProbes,
	type NixStoreConfig,
	type NixSubstitutionSettings
} from './store-config.ts';

const bareMachine: NixMachineProbes = {
	canReadWrite: () => false,
	isFilePresent: () => false,
	hasHardwareVirtualisation: () => false,
	isWsl1: () => false,
	microarchitectureLevels: () => []
};

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
		fallback: false,
		substituters: ['https://cache.nixos.org/']
	},
	building: { systems: ['x86_64-linux'], features: [] },
	fileTransfer: defaultFileTransferSettings,
	signatures: defaultSignatureSettings,
	unknownSettings: []
};

interface Probes {
	readonly canWrite?: boolean;
	readonly socket?: boolean;
	readonly stateDirectoryExists?: boolean;
	readonly superuser?: boolean;
	readonly created?: boolean;
}

const noFiles = new Map<string, string>();

const workingDirectory = '/work/dir';

function noHomeDirectory(): string | undefined {
	return noFiles.get('home');
}

function environmentWith(
	env: Record<string, string>,
	probes: Probes = {}
): StoreClientEnvironment {
	return {
		env,
		readFile: (filePath) => noFiles.get(filePath),
		homeDirectory: () => noFiles.get('home'),
		workingDirectory: () => workingDirectory,
		currentSystem: () => 'x86_64-linux',
		probes: bareMachine,
		canWriteStateDirectory: () => probes.canWrite ?? false,
		socketExists: () => probes.socket ?? false,
		directoryExists: () => probes.stateDirectoryExists ?? true,
		isSuperuser: () => probes.superuser ?? false,
		createDirectory: () => probes.created ?? true
	};
}

function resolve(
	storeUri: string,
	probes: Probes = {},
	env: Record<string, string> = {}
): StoreBackend {
	return resolveStoreBackend(
		{ ...baseConfig, storeUri },
		environmentWith(env, probes)
	);
}

function environment(env: Record<string, string>): StoreClientEnvironment {
	return environmentWith(env, { socket: true, canWrite: false });
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
		{
			name: 'the daemon reference to the configured socket',
			uri: 'daemon',
			probes: {},
			expected: daemon
		},
		{
			name: 'the local reference to the configured directories',
			uri: 'local',
			probes: {},
			expected: local
		},
		{
			name: 'an empty reference through automatic selection',
			uri: '',
			probes: { canWrite: true },
			expected: local
		},
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
			name: 'auto on a machine whose state directory exists but is read-only',
			uri: 'auto',
			probes: { canWrite: false, socket: false, stateDirectoryExists: true },
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
				remote: {
					destination: 'build@example.test',
					host: 'example.test'
				}
			}
		},
		{
			name: 'an ssh-ng URI with remote-program',
			uri: 'ssh-ng://example.test?remote-program=/opt/nix/bin/nix-daemon',
			probes: {},
			expected: {
				backend: 'ssh-ng',
				remote: {
					destination: 'example.test',
					host: 'example.test',
					remoteProgram: ['/opt/nix/bin/nix-daemon']
				}
			}
		}
	])('resolves $name', ({ uri, probes, expected }) => {
		expect(resolve(uri, probes)).toStrictEqual(expected);
	});

	it.each<{ name: string; uri: string; expected: StoreBackend }>([
		{
			name: 'a root parameter for both store and state',
			uri: 'local?root=/rooted',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			name: 'a root parameter on local://',
			uri: 'local://?root=/rooted',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			name: 'a local URI path used as the root',
			uri: 'local:///rooted',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			name: 'a percent-encoded root in the URI',
			uri: 'local:///rooted%20store',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted store/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted store/nix/store'
			}
		},
		{
			name: 'a local URI path with a state parameter',
			uri: 'local:///rooted?state=/named/state',
			expected: {
				backend: 'local',
				stateDirectory: '/named/state',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			name: 'a root parameter overriding the URI path',
			uri: 'local:///named?root=/rooted',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			name: 'the filesystem root without another prefix',
			uri: 'local:///',
			expected: {
				backend: 'local',
				stateDirectory: '/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/nix/store'
			}
		},
		{
			name: 'independent store and state parameters',
			uri: 'local?store=/named/store&state=/named/state',
			expected: {
				backend: 'local',
				stateDirectory: '/named/state',
				storeDirectory: storeDirectorySchema.parse('/named/store')
			}
		},
		{
			name: 'a state parameter overriding the root-derived state directory',
			uri: 'local?root=/rooted&state=/named/state',
			expected: {
				backend: 'local',
				stateDirectory: '/named/state',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			name: 'a real parameter overriding the root-derived store directory',
			uri: 'local?root=/rooted&real=/elsewhere',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/elsewhere'
			}
		},
		{
			name: 'a state directory alone, leaving the configured store',
			uri: 'local?state=/named/state',
			expected: {
				backend: 'local',
				stateDirectory: '/named/state',
				storeDirectory: storeDirectorySchema.parse('/nix/store')
			}
		},
		{
			name: 'the first of two root assignments',
			uri: 'local?root=/first&root=/second',
			expected: {
				backend: 'local',
				stateDirectory: '/first/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/first/nix/store'
			}
		},
		{
			name: 'an unknown parameter alongside a valid root',
			uri: 'local?no-such-parameter=1&root=/rooted',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			name: 'a percent-encoded root',
			uri: 'local?root=/rooted%20store',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted store/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted store/nix/store'
			}
		},
		{
			name: 'an empty root parameter',
			uri: 'local?root=',
			expected: local
		},
		{
			name: 'a root parameter without an equals sign',
			uri: 'local?root',
			expected: local
		}
	])('resolves directories for $name', ({ uri, expected }) => {
		expect(resolve(uri)).toStrictEqual(expected);
	});

	it.each([
		{ name: 'a root that is not an absolute path', uri: 'local?root=rooted' },
		{ name: 'a relative state directory', uri: 'local?state=state' },
		{ name: 'a relative real store directory', uri: 'local?real=store' },
		{ name: 'a relative logical store directory', uri: 'local?store=store' },
		{
			name: 'a logical store directory containing a parent segment',
			uri: 'local?store=/nix/../store'
		}
	])('rejects $name', ({ uri }) => {
		expect(() => resolve(uri)).toThrow(InvalidNixStoreParameterError);
	});

	it.each([
		{ name: 'an unsupported scheme', uri: 'ssh://builder' },
		{ name: 'an ssh-ng store with no destination', uri: 'ssh-ng://' },
		{ name: 'an HTTP binary cache', uri: 'https://cache.example' },
		{ name: 'an unsupported local-x scheme', uri: 'local-x?root=/a' }
	])('rejects $name', ({ uri }) => {
		expect(() => resolve(uri)).toThrow(UnsupportedNixStoreError);
	});

	describe('automatic fallback on Linux without a local store or daemon', () => {
		const unserved: Probes = {
			canWrite: false,
			socket: false,
			stateDirectoryExists: false
		};
		const chroot = (root: string): StoreBackend => ({
			backend: 'local',
			stateDirectory: `${root}/nix/var/nix`,
			storeDirectory: baseConfig.storeDirectory,
			realStoreDirectory: `${root}/nix/store`
		});

		function resolveOnLinux(
			probes: Probes,
			env: Record<string, string> = {},
			home: () => string | undefined = () => '/home/u'
		): StoreBackend {
			return resolveStoreBackend(baseConfig, {
				...environmentWith(env, probes),
				currentSystem: () => 'x86_64-linux',
				homeDirectory: home
			});
		}

		it.each<{
			readonly name: string;
			readonly env: Record<string, string>;
			readonly expected: StoreBackend;
		}>([
			{
				name: 'the HOME fallback',
				env: {},
				expected: chroot('/home/u/.local/share/nix/root')
			},
			{
				name: 'XDG_DATA_HOME',
				env: { XDG_DATA_HOME: '/xdg/data' },
				expected: chroot('/xdg/data/nix/root')
			},
			{
				name: 'NIX_DATA_HOME ahead of XDG_DATA_HOME',
				env: { NIX_DATA_HOME: '/nix/data', XDG_DATA_HOME: '/xdg/data' },
				expected: chroot('/nix/data/root')
			}
		])('uses $name as the chroot root', ({ env, expected }) => {
			expect(resolveOnLinux(unserved, env)).toStrictEqual(expected);
		});

		it.each<{
			readonly name: string;
			readonly probes: Probes;
			readonly env: Record<string, string>;
		}>([
			{
				name: 'the state directory already exists',
				probes: { ...unserved, stateDirectoryExists: true },
				env: {}
			},
			{
				name: 'this process is the superuser',
				probes: { ...unserved, superuser: true },
				env: {}
			},
			{
				name: 'the environment specifies a store directory',
				probes: unserved,
				env: { NIX_STORE_DIR: '/env/store' }
			},
			{
				name: 'the environment specifies a state directory',
				probes: unserved,
				env: { NIX_STATE_DIR: '/env/state' }
			},
			{
				name: 'the directory cannot be created',
				probes: { ...unserved, created: false },
				env: {}
			}
		])('keeps the configured store when $name', ({ probes, env }) => {
			expect(resolveOnLinux(probes, env)).toStrictEqual(local);
		});

		it('keeps the configured store with no home directory to root under', () => {
			expect(resolveOnLinux(unserved, {}, noHomeDirectory)).toStrictEqual(
				local
			);
		});

		it('keeps the configured store on a machine that is not Linux', () => {
			expect(resolve('auto', unserved)).toStrictEqual(local);
		});
	});
});

describe('createNixStoreClient', () => {
	it('creates a daemon client for a daemon store', () => {
		expect(
			createNixStoreClient(environment({ NIX_REMOTE: 'daemon' }))
		).toBeInstanceOf(NixDaemonStoreClient);
	});

	it('creates a local client for a local store', () => {
		expect(
			createNixStoreClient(environment({ NIX_REMOTE: 'local' }))
		).toBeInstanceOf(NixLocalStoreClient);
	});

	it('creates a daemon client for an ssh-ng store', () => {
		expect(
			createNixStoreClient(
				environment({ NIX_REMOTE: 'ssh-ng://build@example.test' })
			)
		).toBeInstanceOf(NixDaemonStoreClient);
	});
});

describe('createAvailabilityStoreClient', () => {
	it('keeps an explicitly local store local when the daemon socket exists', () => {
		const store = createAvailabilityStoreClient(
			daemonEnvironment({ canWrite: true, socket: true }),
			baseConfig,
			{ storeUri: 'local' }
		);

		expect(store.kind).toBe('local-filesystem');
	});

	it('returns the logical store directory from a local URI', () => {
		const store = createAvailabilityStoreClient(
			daemonEnvironment({ canWrite: true, socket: false }),
			baseConfig,
			{
				storeUri: 'local?store=/named/store&state=/named/state&real=/named/real'
			}
		);

		expect(store.storeDirectory).toBe('/named/store');
	});

	it('returns the logical directory from an ssh-ng remote-store', () => {
		const store = createAvailabilityStoreClient(
			daemonEnvironment({ canWrite: true, socket: false }),
			baseConfig,
			{
				storeUri:
					'ssh-ng://build@example.test?remote-store=local%3Fstore%3D%2Fremote%2Fstore'
			}
		);

		expect(store.storeDirectory).toBe('/remote/store');
	});

	it('rejects an invalid boolean substitution override', () => {
		expect(() => localWithSubstitute('off')).toThrow(NixConfigSettingError);
	});

	it.each([
		{
			name: 'an explicitly requested binary cache',
			storeUri: 'https://cache.example'
		},
		{
			name: 'an explicitly requested unsupported scheme',
			storeUri: 'ssh://builder'
		},
		{
			name: 'an explicitly requested ssh-ng store with no destination',
			storeUri: 'ssh-ng://'
		}
	])(
		'rejects $name instead of opening the configured store',
		({ storeUri }) => {
			expect(() => openForAvailability({ storeUri })).toThrow(
				UnsupportedNixStoreError
			);
		}
	);

	it.each([
		{ name: 'an absolute path', storeUri: '/rooted' },
		{ name: 'a relative path', storeUri: './rooted' },
		{ name: 'an equivalent local URI path', storeUri: 'local:///rooted' },
		{ name: 'a root parameter', storeUri: 'local?root=/rooted' }
	])('selects a local-filesystem backend for $name', ({ storeUri }) => {
		expect(openForAvailability({ storeUri }).kind).toBe('local-filesystem');
	});
});

function openForAvailability(
	options: NixDaemonClientOptions
): AvailabilityStore {
	return createAvailabilityStoreClient(
		daemonEnvironment({ canWrite: true, socket: false }),
		undefined,
		options
	);
}

describe('overriddenSubstitution', () => {
	const discovered: NixSubstitutionSettings = {
		substitute: true,
		alwaysAllowSubstitutes: false,
		fallback: false,
		substituters: ['https://configured.example']
	};

	it.each<{
		readonly name: string;
		readonly overrides: NixDaemonOverrides;
		readonly expected: NixSubstitutionSettings;
	}>([
		{
			name: 'leaves discovered settings unchanged with no overrides',
			overrides: {},
			expected: discovered
		},
		{
			name: 'replaces the configured substituter list',
			overrides: { substituters: 'https://only.example' },
			expected: { ...discovered, substituters: ['https://only.example'] }
		},
		{
			name: 'appends to the configured substituter list',
			overrides: { 'extra-substituters': 'https://extra.example' },
			expected: {
				...discovered,
				substituters: ['https://configured.example', 'https://extra.example']
			}
		},
		{
			name: 'replaces and then appends to the substituter list',
			overrides: {
				substituters: 'https://only.example',
				'extra-substituters': 'https://extra.example'
			},
			expected: {
				...discovered,
				substituters: ['https://only.example', 'https://extra.example']
			}
		},
		{
			name: 'clears the substituter list with an empty assignment',
			overrides: { substituters: '' },
			expected: { ...discovered, substituters: [] }
		},
		{
			name: 'preserves duplicate substituter entries',
			overrides: {
				substituters: 'https://one.example https://one.example'
			},
			expected: {
				...discovered,
				substituters: ['https://one.example', 'https://one.example']
			}
		},
		{
			name: 'disables substitution',
			overrides: { substitute: 'no' },
			expected: { ...discovered, substitute: false }
		},
		{
			name: 'enables always-allow-substitutes',
			overrides: { 'always-allow-substitutes': 'true' },
			expected: { ...discovered, alwaysAllowSubstitutes: true }
		},
		{
			name: 'enables fallback',
			overrides: { fallback: '1' },
			expected: { ...discovered, fallback: true }
		}
	])('$name', ({ overrides, expected }) => {
		expect(overriddenSubstitution(discovered, overrides)).toStrictEqual(
			expected
		);
	});
});

function localWithSubstitute(value: string): NixStoreClient {
	return createAvailabilityStoreClient(
		daemonEnvironment({ canWrite: true, socket: false }),
		undefined,
		{ overrides: { substitute: value } }
	).client;
}

function daemonEnvironment(probes: Probes): StoreClientEnvironment {
	return environmentWith({}, probes);
}

describe('createNixDaemonStoreClient', () => {
	it.each([
		{ name: 'a local daemon', storeUri: 'daemon', socket: true },
		{
			name: 'an ssh daemon',
			storeUri: 'ssh-ng://build@example.test',
			socket: false
		}
	])(
		'rejects with the abort reason before connecting to $name',
		async ({ storeUri, socket }) => {
			const reason = new Error('stop opening the store');
			let connections = 0;
			const client = createNixDaemonStoreClient(
				daemonEnvironment({ socket }),
				baseConfig,
				{
					storeUri,
					signal: AbortSignal.abort(reason),
					connect: () => {
						connections += 1;
						return Promise.resolve(new FakeDaemonTransport({}));
					}
				}
			);

			await expect(client.queryValidPaths([])).rejects.toBe(reason);
			expect(connections).toBe(0);
		}
	);

	it.each([
		{ name: 'a writable state directory', canWrite: true },
		{ name: 'a read-only state directory', canWrite: false }
	])('opens the daemon when its socket exists with $name', ({ canWrite }) => {
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

	it('probes the socket path from a unix store URI', () => {
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

	it('preserves the remote daemon policy when opening an ssh-ng store', async () => {
		const storePath = storePathSchema.parse(
			'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
		);
		const client = createNixDaemonStoreClient(
			daemonEnvironment({ socket: false }),
			{ ...baseConfig, storeUri: 'ssh-ng://build@example.test' },
			{
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
							{ expectSetOptions: false }
						)
					)
			}
		);

		await expect(client.queryValidPaths([storePath])).resolves.toStrictEqual([
			storePath
		]);
		expect(client.preservesDaemonOptions).toBe(true);
	});

	it('uses a per-call ssh-ng storeUri instead of the configured local store', async () => {
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
						new FakeDaemonTransport(
							{
								[storePath]: {
									hash: '11'.repeat(32),
									narSize: 123,
									references: [],
									signatures: []
								}
							},
							{ expectSetOptions: false }
						)
					)
			}
		);

		await expect(client.queryValidPaths([storePath])).resolves.toStrictEqual([
			storePath
		]);
	});

	it('decodes ssh-ng realisations in the remote store directory', async () => {
		const derivation = storePathSchema.parse(
			'/remote/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv'
		);
		const output = storePathSchema.parse(
			'/remote/store/0123456789abcdfghijklmnpqrsvwxyz-app'
		);
		const target: NixDerivedPathString = `${derivation}^out`;
		const realisation = JSON.stringify({
			outPath: output.slice('/remote/store/'.length)
		});
		const client = createNixDaemonStoreClient(
			daemonEnvironment({ socket: false }),
			baseConfig,
			{
				storeUri:
					'ssh-ng://build@example.test?remote-store=local%3Fstore%3D%2Fremote%2Fstore',
				connect: () =>
					Promise.resolve(
						new FakeDaemonTransport(
							{},
							{
								expectSetOptions: false,
								builds: {
									expectedTargets: [`${derivation}!out`],
									results: [
										{
											target: `${derivation}!out`,
											status: 13,
											errorMessage: '',
											timesBuilt: 0,
											nonDeterministic: false,
											startTime: 0,
											stopTime: 0,
											builtOutputs: [
												{
													id: `sha256:${'aa'.repeat(32)}!out`,
													realisation
												}
											]
										}
									]
								}
							}
						)
					)
			}
		);

		await expect(client.buildPathsWithResults([target])).resolves.toStrictEqual(
			[
				{
					target,
					outcome: {
						kind: 'resolves-to-already-valid',
						outputs: { out: output }
					},
					timesBuilt: 0,
					nonDeterministic: false,
					startTime: 0,
					stopTime: 0
				}
			]
		);
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
