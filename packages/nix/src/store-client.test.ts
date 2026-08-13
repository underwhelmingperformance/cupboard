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

/** A machine offering nothing a build can ask for beyond the portable names. */
const bareMachine: NixMachineProbes = {
	canReadWrite: () => false,
	fileExists: () => false,
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

/** The directory these fixtures run in. A relative path resolves against it. */
const workingDirectory = '/work/dir';

/** A machine that reports no home directory, as one with no passwd entry does. */
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
		{ name: 'daemon', uri: 'daemon', probes: {}, expected: daemon },
		{ name: 'local', uri: 'local', probes: {}, expected: local },
		{
			name: 'an empty reference, which names the automatic store',
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

	// A local store URI names its own directories. `root` puts the store and
	// the state under one directory, while `store`, `state` and `real` name
	// one each; a parameter naming one outright is the one that stands.
	it.each<{ name: string; uri: string; expected: StoreBackend }>([
		{
			name: 'a root the store and the state sit under',
			uri: 'local?root=/rooted',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			name: 'the same root behind the scheme separator',
			uri: 'local://?root=/rooted',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			// A `local://` URI can name a path. That path is the store's root. A
			// reference written as a path resolves to the same store.
			name: 'a root in the URI',
			uri: 'local:///rooted',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			name: 'a root in the URI, with parameters after it',
			uri: 'local:///rooted?state=/named/state',
			expected: {
				backend: 'local',
				stateDirectory: '/named/state',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			// Nix takes the root from the URI only when no parameter names one, so
			// a `root` parameter wins.
			name: 'a root parameter, which wins over the URI',
			uri: 'local:///named?root=/rooted',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			name: 'the root directory, where this machine keeps its store',
			uri: 'local:///',
			expected: {
				backend: 'local',
				stateDirectory: '/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/nix/store'
			}
		},
		{
			name: 'a store and a state directory named one at a time',
			uri: 'local?store=/named/store&state=/named/state',
			expected: {
				backend: 'local',
				stateDirectory: '/named/state',
				storeDirectory: storeDirectorySchema.parse('/named/store')
			}
		},
		{
			name: 'a state directory over the one a root would settle',
			uri: 'local?root=/rooted&state=/named/state',
			expected: {
				backend: 'local',
				stateDirectory: '/named/state',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			name: 'a real directory over the one a root would settle',
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
			// Nix reads the first assignment of a parameter named twice.
			name: 'the first of two roots',
			uri: 'local?root=/first&root=/second',
			expected: {
				backend: 'local',
				stateDirectory: '/first/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/first/nix/store'
			}
		},
		{
			// A parameter Nix has no setting for is one it warns about and
			// reads nothing out of.
			name: 'a parameter naming no setting, alongside one that does',
			uri: 'local?no-such-parameter=1&root=/rooted',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted/nix/store'
			}
		},
		{
			// A directory named with characters a URI escapes is the directory
			// those characters spell.
			name: 'a root written with an escaped character',
			uri: 'local?root=/rooted%20store',
			expected: {
				backend: 'local',
				stateDirectory: '/rooted store/nix/var/nix',
				storeDirectory: storeDirectorySchema.parse('/nix/store'),
				realStoreDirectory: '/rooted store/nix/store'
			}
		},
		{
			// An empty value names no directory, which leaves the parameter
			// settling nothing.
			name: 'an empty root, which settles nothing',
			uri: 'local?root=',
			expected: local
		},
		{
			name: 'an assignment carrying no value at all',
			uri: 'local?root',
			expected: local
		}
	])('selects $name', ({ uri, expected }) => {
		expect(resolve(uri)).toStrictEqual(expected);
	});

	it.each([
		{ name: 'a root that is not an absolute path', uri: 'local?root=rooted' },
		{ name: 'a state directory that is not one', uri: 'local?state=state' },
		{ name: 'a real directory that is not one', uri: 'local?real=store' },
		{ name: 'a store directory that is not one', uri: 'local?store=store' },
		{
			name: 'a store directory no store path could sit under',
			uri: 'local?store=/nix/../store'
		}
	])('rejects $name', ({ uri }) => {
		expect(() => resolve(uri)).toThrow(InvalidNixStoreParameterError);
	});

	it.each([
		{ name: 'an unsupported scheme', uri: 'ssh://builder' },
		{ name: 'an ssh-ng store with no destination', uri: 'ssh-ng://' },
		{
			// A binary cache serves narinfos and NARs, which is not a store
			// this client can read path information from.
			name: 'a binary cache',
			uri: 'https://cache.example'
		},
		{
			name: 'a store URI naming another scheme entirely',
			uri: 'local-x?root=/a'
		}
	])('rejects $name', ({ uri }) => {
		expect(() => resolve(uri)).toThrow(UnsupportedNixStoreError);
	});

	// Nix sets up a store of the user's own when there is no `/nix` to read,
	// no daemon to ask, and nothing in the environment naming directories it
	// should use instead. That is what an ordinary Linux user who has never
	// installed Nix gets.
	describe('the chroot store an unserved Linux machine falls back to', () => {
		const unserved: Probes = {
			canWrite: false,
			socket: false,
			stateDirectoryExists: false
		};
		// The store keeps naming its paths the way the configuration names
		// them, and holds them under the root, which is how Nix reaches any
		// store under one.
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
				name: 'the data directory under the home directory',
				env: {},
				expected: chroot('/home/u/.local/share/nix/root')
			},
			{
				name: 'the data home the environment names',
				env: { XDG_DATA_HOME: '/xdg/data' },
				expected: chroot('/xdg/data/nix/root')
			},
			{
				name: "Nix's own data home, ahead of the XDG one",
				env: { NIX_DATA_HOME: '/nix/data', XDG_DATA_HOME: '/xdg/data' },
				expected: chroot('/nix/data/root')
			}
		])('roots at $name', ({ env, expected }) => {
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
				name: 'the environment names a store directory',
				probes: unserved,
				env: { NIX_STORE_DIR: '/env/store' }
			},
			{
				name: 'the environment names a state directory',
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

		// A machine reporting no home directory has nowhere to root a store of
		// the user's own, so the configured one stands.
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

// A daemon reads the settings its client sends it through the configuration
// layer, so an override reaching a store this process drives has to be read
// the same way: Nix accepts three spellings for each of a setting's two
// values, and refuses the rest.
describe('createAvailabilityStoreClient', () => {
	it('refuses an override Nix would not read as a setting value', () => {
		expect(() => localWithSubstitute('off')).toThrow(NixConfigSettingError);
	});

	// Nix refuses to open a store it cannot read. Answering from the configured
	// store instead would report on a store the caller never named.
	it.each([
		{ name: 'a binary cache', storeUri: 'https://cache.example' },
		{ name: 'a scheme that opens no store here', storeUri: 'ssh://builder' },
		{ name: 'an ssh-ng store with no destination', storeUri: 'ssh-ng://' }
	])('refuses $name', ({ storeUri }) => {
		expect(() => openForAvailability({ storeUri })).toThrow(
			UnsupportedNixStoreError
		);
	});

	// A path names a local store rooted at that path. Nix resolves the
	// reference before it opens the store, so a caller naming a path reads that
	// store rather than the configured one.
	it.each([
		{ name: 'an absolute path', storeUri: '/rooted' },
		{ name: 'a relative path', storeUri: './rooted' },
		{ name: 'the URI a path resolves to', storeUri: 'local:///rooted' },
		{ name: 'a root parameter', storeUri: 'local?root=/rooted' }
	])('opens the store named by $name', ({ storeUri }) => {
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
			name: 'settling nothing',
			overrides: {},
			expected: discovered
		},
		{
			name: 'replacing the configured list',
			overrides: { substituters: 'https://only.example' },
			expected: { ...discovered, substituters: ['https://only.example'] }
		},
		{
			name: 'appending to the configured list',
			overrides: { 'extra-substituters': 'https://extra.example' },
			expected: {
				...discovered,
				substituters: ['https://configured.example', 'https://extra.example']
			}
		},
		{
			name: 'replacing and appending together',
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
			name: 'replacing the list with none',
			overrides: { substituters: '' },
			expected: { ...discovered, substituters: [] }
		},
		{
			// A daemon holds what its client sends it as the list setting it is,
			// so a substituter named twice is held twice there as well.
			name: 'naming the same substituter twice',
			overrides: {
				substituters: 'https://one.example https://one.example'
			},
			expected: {
				...discovered,
				substituters: ['https://one.example', 'https://one.example']
			}
		},
		{
			name: 'turning substitution off',
			overrides: { substitute: 'no' },
			expected: { ...discovered, substitute: false }
		},
		{
			name: 'overruling a derivation that withholds substitution',
			overrides: { 'always-allow-substitutes': 'true' },
			expected: { ...discovered, alwaysAllowSubstitutes: true }
		},
		{
			name: 'tolerating a substituter that fails',
			overrides: { fallback: '1' },
			expected: { ...discovered, fallback: true }
		}
	])('settles the settings an override $name', ({ overrides, expected }) => {
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
