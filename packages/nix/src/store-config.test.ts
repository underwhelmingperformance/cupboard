import { availableParallelism } from 'node:os';

import { storeDirectoryMaxLength } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	InvalidNixStoreDirectoryError,
	NixConfigIncludeError,
	NixConfigSettingError,
	NixConfigSyntaxError,
	NixMachineFileError
} from './nix-store.ts';
import {
	defaultFileTransferSettings,
	defaultSignatureSettings,
	discoverNixStoreConfig,
	microarchitectureLevelsOf,
	type NixBuildSettings,
	type NixConfigEnvironment,
	type NixMachineProbes,
	type NixSignatureSettings,
	type NixStoreConfig,
	type NixSubstitutionSettings
} from './store-config.ts';

interface Fixture {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly files?: Readonly<Record<string, string>>;
	readonly home?: string;
	/** The machine the fixture discovers on, defaulting to an Apple silicon one. */
	readonly currentSystem?: () => string | undefined;
	/**
	 * What that machine offers a build. The default offers nothing beyond the
	 * portable names, so a fixture states the capability it is describing.
	 */
	readonly probes?: Partial<NixMachineProbes>;
}

/** A machine offering nothing a build can ask for beyond the portable names. */
const bareMachine: NixMachineProbes = {
	canReadWrite: () => false,
	fileExists: () => false,
	hasHardwareVirtualisation: () => false,
	isWsl1: () => false,
	microarchitectureLevels: () => []
};

function environmentFrom(fixture: Fixture): NixConfigEnvironment {
	return {
		env: fixture.env ?? {},
		readFile: (filePath) => fixture.files?.[filePath],
		homeDirectory: () => fixture.home,
		currentSystem: fixture.currentSystem ?? (() => 'aarch64-darwin'),
		probes: { ...bareMachine, ...fixture.probes }
	};
}

function discover(fixture: Fixture): NixStoreConfig {
	return discoverNixStoreConfig(environmentFrom(fixture));
}

function thrownBy(fixture: Fixture): unknown {
	try {
		discover(fixture);
	} catch (error) {
		return error;
	}

	return undefined;
}

const overlongStoreDirectory = `/${'d'.repeat(storeDirectoryMaxLength)}`;

// A machine whose CPU or kernel has no Nix name, so nothing reports a system.
const unnamedMachine = new Map<string, string>();

// Nix's own defaults: substitution on, a derivation's `allowSubstitutes`
// honoured, and the one compiled-in substituter.
const defaultSubstitution: NixSubstitutionSettings = {
	substitute: true,
	alwaysAllowSubstitutes: false,
	fallback: false,
	substituters: ['https://cache.nixos.org/']
};

// The bare Apple silicon machine the fixtures describe: no Rosetta, so it
// runs only its own system, and no hardware virtualisation to offer.
const defaultBuilding: NixBuildSettings = {
	systems: ['aarch64-darwin'],
	features: ['nixos-test', 'benchmark', 'big-parallel']
};

/** A machine with Rosetta 2 installed, which Nix reads from that one file. */
const rosettaInstalled = {
	fileExists: (filePath: string) =>
		filePath === '/Library/Apple/usr/libexec/oah/libRosettaRuntime'
};

// The psABI levels, as the x86-64 ABI defines them. Each level subsumes the
// one below it, so a CPU missing one feature of a level has none of the levels
// above it either.
const secondLevelFlags = [
	'cx16',
	'lahf_lm',
	'popcnt',
	'pni',
	'sse4_1',
	'sse4_2',
	'ssse3'
];
const thirdLevelFlags = [
	'avx',
	'avx2',
	'bmi1',
	'bmi2',
	'f16c',
	'fma',
	'abm',
	'movbe',
	'xsave'
];
const fourthLevelFlags = [
	'avx512f',
	'avx512bw',
	'avx512cd',
	'avx512dq',
	'avx512vl'
];

describe('microarchitectureLevelsOf', () => {
	it.each([
		{ name: 'no flags at all', flags: [], expected: ['x86_64-v1'] },
		{
			name: 'the second level',
			flags: secondLevelFlags,
			expected: ['x86_64-v1', 'x86_64-v2']
		},
		{
			name: 'the second level one flag short',
			flags: secondLevelFlags.slice(1),
			expected: ['x86_64-v1']
		},
		{
			name: 'the third level',
			flags: [...secondLevelFlags, ...thirdLevelFlags],
			expected: ['x86_64-v1', 'x86_64-v2', 'x86_64-v3']
		},
		{
			name: 'the fourth level',
			flags: [...secondLevelFlags, ...thirdLevelFlags, ...fourthLevelFlags],
			expected: ['x86_64-v1', 'x86_64-v2', 'x86_64-v3', 'x86_64-v4']
		},
		{
			name: 'the fourth level without the third',
			flags: [...secondLevelFlags, ...fourthLevelFlags],
			expected: ['x86_64-v1', 'x86_64-v2']
		}
	])('reports $name', ({ flags, expected }) => {
		expect(microarchitectureLevelsOf(new Set(flags))).toStrictEqual(expected);
	});
});

describe('discoverNixStoreConfig', () => {
	it('falls back to the compiled defaults with no configuration', () => {
		expect(discover({})).toStrictEqual({
			storeUri: 'auto',
			storeDirectory: '/nix/store',
			stateDirectory: '/nix/var/nix',
			daemonSocketPath: '/nix/var/nix/daemon-socket/socket',
			daemonSetOptions: {},
			daemonOverrides: {},
			substitution: defaultSubstitution,
			building: defaultBuilding,
			fileTransfer: defaultFileTransferSettings,
			signatures: defaultSignatureSettings
		});
	});

	it('reads the store URI from NIX_REMOTE', () => {
		expect(discover({ env: { NIX_REMOTE: 'daemon' } }).storeUri).toBe('daemon');
	});

	it('lets the store setting override NIX_REMOTE', () => {
		const config = discover({
			env: { NIX_REMOTE: 'daemon' },
			files: { '/etc/nix/nix.conf': 'store = local\n' }
		});

		expect(config.storeUri).toBe('local');
	});

	it.each([
		{
			name: 'the system file',
			fixture: {
				files: { '/etc/nix/nix.conf': 'post-build-hook = /etc/nix/hook.sh\n' }
			},
			expected: '/etc/nix/hook.sh'
		},
		{
			name: 'the inline NIX_CONFIG, shadowing the system file',
			fixture: {
				env: { NIX_CONFIG: 'post-build-hook = /inline/hook.sh' },
				files: { '/etc/nix/nix.conf': 'post-build-hook = /etc/nix/hook.sh\n' }
			},
			expected: '/inline/hook.sh'
		},
		{
			name: 'no configured hook',
			fixture: {},
			expected: undefined
		}
	])(
		'surfaces the effective post-build-hook from $name',
		({ fixture, expected }) => {
			expect(discover(fixture).postBuildHook).toBe(expected);
		}
	);

	// No configuration file names the store directory: a store serving
	// another one says so in its own URI, so a `store-dir` line is a setting
	// Nix does not have.
	it('takes no store directory from a configuration file', () => {
		const config = discover({
			home: '/home/u',
			files: {
				'/etc/nix/nix.conf': 'store-dir = /system/store\n',
				'/home/u/.config/nix/nix.conf': 'store-dir = /user/store\n'
			}
		});

		expect(config.storeDirectory).toBe('/nix/store');
	});

	it.each([
		{ name: 'NIX_STORE_DIR', env: { NIX_STORE_DIR: '/env/store' } },
		{
			name: 'NIX_STORE, which Nix reads after it',
			env: { NIX_STORE: '/env/store' }
		},
		{
			name: 'NIX_STORE_DIR ahead of NIX_STORE',
			env: { NIX_STORE_DIR: '/env/store', NIX_STORE: '/other/store' }
		}
	])('takes the store directory from $name', ({ env }) => {
		expect(discover({ env }).storeDirectory).toBe('/env/store');
	});

	// Nix canonicalises the directory, so a value naming the same one a
	// different way names the same store.
	it.each([
		{ name: 'a trailing slash', value: '/nix/store/' },
		{ name: 'a doubled slash', value: '/nix//store' },
		{ name: 'a current segment', value: '/nix/./store' },
		{ name: 'a parent segment', value: '/nix/other/../store' }
	])('reads a store directory named with $name', ({ value }) => {
		expect(discover({ env: { NIX_STORE_DIR: value } }).storeDirectory).toBe(
			'/nix/store'
		);
	});

	it('derives the socket path from NIX_STATE_DIR', () => {
		const config = discover({ env: { NIX_STATE_DIR: '/srv/nix' } });

		expect(config).toStrictEqual({
			storeUri: 'auto',
			storeDirectory: '/nix/store',
			stateDirectory: '/srv/nix',
			daemonSocketPath: '/srv/nix/daemon-socket/socket',
			daemonSetOptions: {},
			daemonOverrides: {},
			substitution: defaultSubstitution,
			building: defaultBuilding,
			fileTransfer: defaultFileTransferSettings,
			signatures: defaultSignatureSettings
		});
	});

	it('lets NIX_DAEMON_SOCKET_PATH override the derived socket path', () => {
		const config = discover({
			env: { NIX_DAEMON_SOCKET_PATH: '/run/nix-daemon.sock' }
		});

		expect(config.daemonSocketPath).toBe('/run/nix-daemon.sock');
	});

	it('applies inline NIX_CONFIG above the files', () => {
		const config = discover({
			env: { NIX_CONFIG: 'store = daemon' },
			files: { '/etc/nix/nix.conf': 'store = local\n' }
		});

		expect(config.storeUri).toBe('daemon');
	});

	it('ignores comments and blank lines', () => {
		const config = discover({
			files: {
				'/etc/nix/nix.conf': '# a comment\n\n  store = local  # trailing\n'
			}
		});

		expect(config.storeUri).toBe('local');
	});

	it('follows include directives relative to the including file', () => {
		const config = discover({
			files: {
				'/etc/nix/nix.conf': 'include extra.conf\n',
				'/etc/nix/extra.conf': 'store = local\n'
			}
		});

		expect(config.storeUri).toBe('local');
	});

	it('skips a missing optional include', () => {
		const config = discover({
			files: { '/etc/nix/nix.conf': '!include missing.conf\nstore = local\n' }
		});

		expect(config.storeUri).toBe('local');
	});

	it('throws on a missing required include', () => {
		expect(() =>
			discover({ files: { '/etc/nix/nix.conf': 'include missing.conf\n' } })
		).toThrow(NixConfigIncludeError);
	});

	// Nix reads a line as whitespace-separated tokens and requires
	// `<name> = <value…>`, refusing the whole configuration over anything
	// else. A client reading past a line Nix would not start with would run
	// under settings Nix does not have.
	it.each([
		{ name: 'a bare word', line: 'store' },
		{ name: 'an assignment with no spaces around it', line: 'store=local' },
		{ name: 'a name with no separator', line: 'store local' },
		{ name: 'an include naming nothing', line: 'include' },
		{ name: 'an include naming two files', line: 'include one.conf two.conf' },
		{ name: 'a setting called include', line: 'include = local' }
	])('refuses $name', ({ line }) => {
		expect(() =>
			discover({ files: { '/etc/nix/nix.conf': `${line}\n` } })
		).toThrow(NixConfigSyntaxError);
	});

	// The value is the tokens after the separator joined by single spaces, so
	// however a line spaces them out the setting holds the same value.
	it('collapses the whitespace inside a value', () => {
		const config = discover({
			files: { '/etc/nix/nix.conf': 'post-build-hook =\t/hook.sh   --flag\n' }
		});

		expect(config.postBuildHook).toBe('/hook.sh --flag');
	});

	it('loads NIX_CONFIG_HOME and XDG_CONFIG_DIRS in Nix precedence order', () => {
		const config = discover({
			env: {
				NIX_CONFIG_HOME: '/job/nix',
				XDG_CONFIG_DIRS: '/first:/second'
			},
			files: {
				'/first/nix/nix.conf': [
					'download-attempts = 3',
					'connect-timeout = 20'
				].join('\n'),
				'/second/nix/nix.conf': 'connect-timeout = 30',
				'/job/nix/nix.conf': [
					'extra-substituters = https://job.example',
					'netrc-file = /job/netrc',
					'connect-timeout = 5'
				].join('\n')
			}
		});

		expect(config.daemonOverrides).toStrictEqual({
			'filetransfer-retry-attempts': '3',
			'connect-timeout': '5',
			'extra-substituters': 'https://job.example',
			'netrc-file': '/job/netrc'
		});
	});

	it('forwards canonical effective daemon overrides from user configuration', () => {
		const config = discover({
			home: '/home/u',
			files: {
				'/etc/nix/nix.conf': [
					'substituters = https://system.example',
					'trusted-public-keys = system-1:key',
					'netrc-file = /etc/nix/system-netrc'
				].join('\n'),
				'/home/u/.config/nix/nix.conf': [
					'extra-substituters = https://user.example',
					'extra-trusted-public-keys = user-1:key'
				].join('\n')
			},
			env: {
				NIX_CONFIG: [
					'extra-substituters = https://job.example',
					'extra-trusted-public-keys = job-1:key',
					'netrc-file = /tmp/job-netrc'
				].join('\n')
			}
		});

		expect(config.daemonOverrides).toStrictEqual({
			'extra-substituters': 'https://user.example https://job.example',
			'extra-trusted-public-keys': 'user-1:key job-1:key',
			'netrc-file': '/tmp/job-netrc'
		});
	});

	it('uses system daemon settings as a base without forwarding them', () => {
		const config = discover({
			files: {
				'/etc/nix/nix.conf': [
					'extra-substituters = https://system.example',
					'extra-trusted-public-keys = system-1:key',
					'netrc-file = /etc/nix/system-netrc'
				].join('\n')
			}
		});

		expect(config.daemonOverrides).toStrictEqual({});
	});

	it('appends inline daemon settings to Nix defaults', () => {
		const config = discover({
			env: {
				NIX_CONFIG: [
					'extra-substituters = https://job.example',
					'extra-trusted-public-keys = job-1:key'
				].join('\n')
			}
		});

		expect(config.daemonOverrides).toStrictEqual({
			'extra-substituters': 'https://job.example',
			'extra-trusted-public-keys': 'job-1:key'
		});
	});

	it('replaces daemon list settings and resolves their aliases', () => {
		const config = discover({
			env: {
				NIX_CONFIG: [
					'binary-caches = https://replacement.example',
					'extra-binary-caches = https://extra.example',
					'binary-cache-public-keys = replacement-1:key',
					'extra-binary-cache-public-keys = extra-1:key'
				].join('\n')
			}
		});

		expect(config.daemonOverrides).toStrictEqual({
			substituters: 'https://replacement.example https://extra.example',
			'trusted-public-keys': 'replacement-1:key extra-1:key'
		});
	});

	it('forwards effective client settings accepted by SetOptions', () => {
		const config = discover({
			home: '/home/u',
			files: {
				'/etc/nix/nix.conf': [
					'connect-timeout = 30',
					'sandbox-paths = /system'
				].join('\n'),
				'/home/u/.config/nix/nix.conf': [
					'connect-timeout = 5',
					'trusted-substituters = https://trusted.example',
					'extra-trusted-substituters = https://extra.example',
					'sandbox-paths = /user',
					'extra-sandbox-paths = /work'
				].join('\n')
			},
			env: {
				NIX_CONFIG: [
					'download-attempts = 2',
					'narinfo-cache-negative-ttl = 0'
				].join('\n')
			}
		});

		expect(config.daemonOverrides).toStrictEqual({
			'connect-timeout': '5',
			'trusted-substituters': 'https://trusted.example https://extra.example',
			'sandbox-paths': '/user /work',
			'filetransfer-retry-attempts': '2',
			'narinfo-cache-negative-ttl': '0'
		});
	});

	it('parses dedicated SetOptions fields and leaves them out of overrides', () => {
		const config = discover({
			env: {
				NIX_CONFIG: [
					'keep-failed = true',
					'keep-going = true',
					'fallback = true',
					'max-jobs = 8',
					'max-silent-time = 30',
					'cores = 4',
					'substitute = false',
					'build-fallback = true',
					'build-max-jobs = 8',
					'build-max-silent-time = 30',
					'build-cores = 4',
					'build-use-substitutes = false',
					'show-trace = true',
					'experimental-features = nix-command flakes',
					'plugin-files = /tmp/plugin.so',
					'extra-plugin-files = /tmp/extra-plugin.so'
				].join('\n')
			}
		});

		expect(config.daemonSetOptions).toStrictEqual({
			keepFailed: true,
			keepGoing: true,
			tryFallback: true,
			maxBuildJobs: 8,
			maxSilentTime: 30,
			buildCores: 4,
			useSubstitutes: false
		});
		expect(config.daemonOverrides).toStrictEqual({});
	});

	it('resolves max-jobs auto to the available parallelism', () => {
		const config = discover({
			env: { NIX_CONFIG: 'max-jobs = auto' }
		});

		expect(config.daemonSetOptions).toStrictEqual({
			maxBuildJobs: availableParallelism()
		});
	});

	it.each([
		{
			name: 'a boolean outside its accepted spellings',
			line: 'keep-failed = maybe',
			setting: 'keep-failed',
			value: 'maybe'
		},
		{
			name: 'a boolean given a number above one',
			line: 'substitute = 2',
			setting: 'substitute',
			value: '2'
		},
		{
			name: 'a word where an integer is expected',
			line: 'max-jobs = many',
			setting: 'max-jobs',
			value: 'many'
		},
		{
			name: 'a negative integer',
			line: 'cores = -4',
			setting: 'cores',
			value: '-4'
		},
		{
			name: 'a fractional integer',
			line: 'max-silent-time = 1.5',
			setting: 'max-silent-time',
			value: '1.5'
		}
	])('refuses $name', ({ line, setting, value }) => {
		const error = thrownBy({ env: { NIX_CONFIG: line } });

		expect(error).toBeInstanceOf(NixConfigSettingError);

		if (!(error instanceof NixConfigSettingError)) {
			throw error;
		}

		expect({
			name: error.name,
			setting: error.setting,
			value: error.value
		}).toStrictEqual({ name: 'NixConfigSettingError', setting, value });
	});

	it('does not load user configuration when NIX_USER_CONF_FILES is empty', () => {
		const config = discover({
			home: '/home/u',
			env: { NIX_USER_CONF_FILES: '' },
			files: {
				'/home/u/.config/nix/nix.conf': 'netrc-file = /home/u/.config/nix/netrc'
			}
		});

		expect(config.daemonOverrides).toStrictEqual({});
	});

	it('does not replace an empty XDG_CONFIG_DIRS with the default', () => {
		const config = discover({
			env: {
				NIX_CONFIG_HOME: '/job/nix',
				XDG_CONFIG_DIRS: ''
			},
			files: {
				'/job/nix/nix.conf': 'connect-timeout = 5',
				'/etc/xdg/nix/nix.conf': 'netrc-file = /etc/xdg/nix/netrc'
			}
		});

		expect(config.daemonOverrides).toStrictEqual({
			'connect-timeout': '5'
		});
	});

	it.each([
		{
			name: 'NIX_CONFIG_HOME',
			env: { NIX_CONFIG_HOME: '' },
			configPath: 'nix.conf'
		},
		{
			name: 'XDG_CONFIG_HOME',
			env: { XDG_CONFIG_HOME: '' },
			configPath: 'nix/nix.conf'
		}
	])('preserves an empty $name', ({ env, configPath }) => {
		const config = discover({
			home: '/home/u',
			env,
			files: {
				[configPath]: 'connect-timeout = 5',
				'/home/u/.config/nix/nix.conf': 'connect-timeout = 30'
			}
		});

		expect(config.daemonOverrides).toStrictEqual({
			'connect-timeout': '5'
		});
	});

	it.each([
		{
			name: 'a relative path in NIX_STORE_DIR',
			fixture: { env: { NIX_STORE_DIR: 'nix/store' } },
			storeDirectory: 'nix/store',
			source: 'NIX_STORE_DIR'
		},
		{
			name: 'the filesystem root in NIX_STORE_DIR',
			fixture: { env: { NIX_STORE_DIR: '/' } },
			storeDirectory: '/',
			source: 'NIX_STORE_DIR'
		},
		{
			name: 'a segment outside the store charset in NIX_STORE_DIR',
			fixture: { env: { NIX_STORE_DIR: '/nix/st ore' } },
			storeDirectory: '/nix/st ore',
			source: 'NIX_STORE_DIR'
		},
		{
			name: 'a directory over the length cap in NIX_STORE_DIR',
			fixture: { env: { NIX_STORE_DIR: overlongStoreDirectory } },
			storeDirectory: overlongStoreDirectory,
			source: 'NIX_STORE_DIR'
		},
		{
			name: 'a relative directory in NIX_STORE_DIR',
			fixture: { env: { NIX_STORE_DIR: '../store' } },
			storeDirectory: '../store',
			source: 'NIX_STORE_DIR'
		},

		{
			name: 'NIX_STORE_DIR shadowing a usable store-dir setting',
			fixture: {
				env: { NIX_STORE_DIR: 'relative/store' },
				files: { '/etc/nix/nix.conf': 'store-dir = /file/store\n' }
			},
			storeDirectory: 'relative/store',
			source: 'NIX_STORE_DIR'
		}
	])('refuses $name', ({ fixture, storeDirectory, source }) => {
		const error = thrownBy(fixture);

		expect(error).toBeInstanceOf(InvalidNixStoreDirectoryError);

		if (!(error instanceof InvalidNixStoreDirectoryError)) {
			throw error;
		}

		expect({
			name: error.name,
			storeDirectory: error.storeDirectory,
			source: error.source
		}).toStrictEqual({
			name: 'InvalidNixStoreDirectoryError',
			storeDirectory,
			source
		});
	});

	it.each([
		{
			name: 'substitution turned off in the system file',
			fixture: { files: { '/etc/nix/nix.conf': 'substitute = false\n' } },
			expected: { ...defaultSubstitution, substitute: false }
		},
		{
			name: 'substitution turned off under its deprecated spelling',
			fixture: {
				files: { '/etc/nix/nix.conf': 'build-use-substitutes = false\n' }
			},
			expected: { ...defaultSubstitution, substitute: false }
		},
		{
			name: 'always-allow-substitutes turned on',
			fixture: {
				files: { '/etc/nix/nix.conf': 'always-allow-substitutes = true\n' }
			},
			expected: { ...defaultSubstitution, alwaysAllowSubstitutes: true }
		},
		{
			name: 'a substituters list replacing the compiled default',
			fixture: {
				files: {
					'/etc/nix/nix.conf':
						'substituters = https://one.example https://two.example\n'
				}
			},
			expected: {
				...defaultSubstitution,
				substituters: ['https://one.example', 'https://two.example']
			}
		},
		{
			name: 'a substituters list under its deprecated spelling',
			fixture: {
				files: { '/etc/nix/nix.conf': 'binary-caches = https://one.example\n' }
			},
			expected: {
				...defaultSubstitution,
				substituters: ['https://one.example']
			}
		},
		{
			name: 'an extra-substituters append over the compiled default',
			fixture: {
				env: { NIX_CONFIG: 'extra-substituters = https://cupboard.example' }
			},
			expected: {
				...defaultSubstitution,
				substituters: ['https://cache.nixos.org/', 'https://cupboard.example']
			}
		},
		{
			name: 'the system file replacing the list and NIX_CONFIG appending to it',
			fixture: {
				files: {
					'/etc/nix/nix.conf': 'substituters = https://system.example\n'
				},
				env: { NIX_CONFIG: 'extra-substituters = https://cupboard.example' }
			},
			expected: {
				...defaultSubstitution,
				substituters: ['https://system.example', 'https://cupboard.example']
			}
		},
		{
			name: 'a later assignment discarding the appends before it',
			fixture: {
				files: {
					'/etc/nix/nix.conf': 'extra-substituters = https://early.example\n'
				},
				env: { NIX_CONFIG: 'substituters = https://late.example' }
			},
			expected: {
				...defaultSubstitution,
				substituters: ['https://late.example']
			}
		},
		{
			name: 'a substituter listed twice',
			fixture: {
				files: {
					'/etc/nix/nix.conf':
						'substituters = https://one.example https://one.example\n'
				}
			},
			expected: {
				...defaultSubstitution,
				substituters: ['https://one.example']
			}
		},
		{
			name: 'an empty substituters list',
			fixture: { files: { '/etc/nix/nix.conf': 'substituters =\n' } },
			expected: { ...defaultSubstitution, substituters: [] }
		}
	])(
		'resolves the substitution settings from $name',
		({ fixture, expected }) => {
			expect(discover(fixture).substitution).toStrictEqual(expected);
		}
	);

	it.each<{
		readonly name: string;
		readonly fixture: Fixture;
		readonly expected: NixSignatureSettings;
	}>([
		{
			name: 'no configuration at all',
			fixture: {},
			expected: defaultSignatureSettings
		},
		{
			name: 'a replaced trusted key list',
			fixture: {
				files: { '/etc/nix/nix.conf': 'trusted-public-keys = mine-1:key\n' }
			},
			expected: {
				...defaultSignatureSettings,
				trustedPublicKeys: ['mine-1:key']
			}
		},
		{
			name: 'an appended trusted key, which keeps the compiled-in one',
			fixture: {
				files: {
					'/etc/nix/nix.conf': 'extra-trusted-public-keys = mine-1:key\n'
				}
			},
			expected: {
				...defaultSignatureSettings,
				trustedPublicKeys: [
					'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=',
					'mine-1:key'
				]
			}
		},
		{
			name: 'the signature requirement turned off',
			fixture: { files: { '/etc/nix/nix.conf': 'require-sigs = false\n' } },
			expected: { ...defaultSignatureSettings, requireSignatures: false }
		},
		{
			name: 'configured secret key files',
			fixture: {
				files: {
					'/etc/nix/nix.conf': 'secret-key-files = /etc/nix/a /etc/nix/b\n'
				}
			},
			expected: {
				...defaultSignatureSettings,
				secretKeyFiles: ['/etc/nix/a', '/etc/nix/b']
			}
		}
	])('resolves the signature settings from $name', ({ fixture, expected }) => {
		expect(discover(fixture).signatures).toStrictEqual(expected);
	});

	it.each<{
		readonly name: string;
		readonly fixture: Fixture;
		readonly expected: NixBuildSettings;
	}>([
		{
			name: 'no configuration at all',
			fixture: {},
			expected: defaultBuilding
		},
		{
			name: 'a machine Nix has no name for',
			fixture: { currentSystem: () => unnamedMachine.get('system') },
			expected: {
				systems: [],
				features: ['nixos-test', 'benchmark', 'big-parallel']
			}
		},
		// The computed platforms and features describe the machine, and Nix
		// takes them from the system it was compiled for and the kernel it
		// probes. Assigning `system` moves what a build is dispatched as, and
		// nothing else: this Mac gains no `i686-linux` and no `uid-range`.
		{
			name: 'an assigned system, which moves nothing the machine decides',
			fixture: { files: { '/etc/nix/nix.conf': 'system = x86_64-linux\n' } },
			expected: {
				systems: ['x86_64-linux'],
				features: ['nixos-test', 'benchmark', 'big-parallel']
			}
		},
		{
			name: 'an x86_64 Linux machine',
			fixture: { currentSystem: () => 'x86_64-linux' },
			expected: {
				systems: ['x86_64-linux', 'i686-linux'],
				features: ['nixos-test', 'benchmark', 'big-parallel', 'uid-range']
			}
		},
		// Nix opens `/dev/kvm` to decide, since a build asking for `kvm` opens
		// it too. A machine without one does not claim the feature.
		{
			name: 'a Linux machine offering hardware virtualisation',
			fixture: {
				currentSystem: () => 'x86_64-linux',
				probes: { canReadWrite: (filePath: string) => filePath === '/dev/kvm' }
			},
			expected: {
				systems: ['x86_64-linux', 'i686-linux'],
				features: [
					'nixos-test',
					'benchmark',
					'big-parallel',
					'uid-range',
					'kvm'
				]
			}
		},
		// WSL 1 carries no kernel that runs i686 binaries, so Nix leaves the
		// platform out there.
		{
			name: 'an x86_64 machine running WSL 1',
			fixture: {
				currentSystem: () => 'x86_64-linux',
				probes: { isWsl1: () => true }
			},
			expected: {
				systems: ['x86_64-linux'],
				features: ['nixos-test', 'benchmark', 'big-parallel', 'uid-range']
			}
		},
		// Nix adds every psABI level the CPU supports as a platform of its own,
		// so a build pinned to one is dispatched here.
		{
			name: 'a Linux machine whose CPU reaches the third psABI level',
			fixture: {
				currentSystem: () => 'x86_64-linux',
				probes: {
					microarchitectureLevels: () => ['x86_64-v1', 'x86_64-v2', 'x86_64-v3']
				}
			},
			expected: {
				systems: [
					'x86_64-linux',
					'i686-linux',
					'x86_64-v1-linux',
					'x86_64-v2-linux',
					'x86_64-v3-linux'
				],
				features: ['nixos-test', 'benchmark', 'big-parallel', 'uid-range']
			}
		},
		// A guest reports its host's support as its own, so Nix asks whether
		// this machine is itself a guest before claiming the feature.
		{
			name: 'a Mac offering hardware virtualisation',
			fixture: { probes: { hasHardwareVirtualisation: () => true } },
			expected: {
				systems: ['aarch64-darwin'],
				features: ['nixos-test', 'benchmark', 'big-parallel', 'apple-virt']
			}
		},
		{
			name: 'a Mac with Rosetta 2 installed',
			fixture: { probes: rosettaInstalled },
			expected: {
				...defaultBuilding,
				systems: ['aarch64-darwin', 'x86_64-darwin']
			}
		},
		{
			name: 'extra platforms replacing the computed ones',
			fixture: {
				files: {
					'/etc/nix/nix.conf': 'extra-platforms = aarch64-linux i686-linux\n'
				}
			},
			expected: {
				...defaultBuilding,
				systems: ['aarch64-darwin', 'aarch64-linux', 'i686-linux']
			}
		},
		{
			name: 'an extra-platforms append over the computed ones',
			fixture: {
				probes: rosettaInstalled,
				files: {
					'/etc/nix/nix.conf': 'extra-extra-platforms = aarch64-linux\n'
				}
			},
			expected: {
				...defaultBuilding,
				systems: ['aarch64-darwin', 'x86_64-darwin', 'aarch64-linux']
			}
		},
		{
			name: 'system features replacing the computed ones',
			fixture: {
				files: { '/etc/nix/nix.conf': 'system-features = kvm big-parallel\n' }
			},
			expected: { ...defaultBuilding, features: ['kvm', 'big-parallel'] }
		},
		{
			name: 'a system-features append over the computed ones',
			fixture: {
				files: {
					'/etc/nix/nix.conf': 'extra-system-features = gccarch-x86-64-v3\n'
				}
			},
			expected: {
				...defaultBuilding,
				features: [
					'nixos-test',
					'benchmark',
					'big-parallel',
					'gccarch-x86-64-v3'
				]
			}
		},
		{
			name: 'an assignment discarding the appends ahead of it',
			fixture: {
				files: {
					'/etc/nix/nix.conf':
						'extra-system-features = discarded\nsystem-features = kvm\n'
				}
			},
			expected: { ...defaultBuilding, features: ['kvm'] }
		},
		{
			name: 'configured remote builders',
			fixture: {
				files: {
					'/etc/nix/nix.conf':
						'builders = ssh://builds.example x86_64-linux - 8\n'
				}
			},
			expected: {
				...defaultBuilding,
				builders: 'ssh://builds.example x86_64-linux - 8'
			}
		},
		{
			name: 'an empty builders setting',
			fixture: { files: { '/etc/nix/nix.conf': 'builders =\n' } },
			expected: defaultBuilding
		},
		// Nix's compiled-in default names the machines file, so a machine
		// declaring its builders there has them without the setting appearing
		// in any configuration file.
		{
			name: 'builders declared only in the machines file',
			fixture: {
				files: {
					'/etc/nix/machines':
						'# a comment\nssh://one.example x86_64-linux\n\nssh://two.example\n'
				}
			},
			expected: {
				...defaultBuilding,
				builders: 'ssh://one.example x86_64-linux\nssh://two.example'
			}
		},
		{
			name: 'no machines file, which names no builders',
			fixture: {},
			expected: defaultBuilding
		},
		{
			name: 'a machines file holding only comments',
			fixture: { files: { '/etc/nix/machines': '# nothing here\n' } },
			expected: defaultBuilding
		},
		{
			name: 'a builders setting naming a file of its own',
			fixture: {
				files: {
					'/etc/nix/nix.conf': 'builders = @/etc/nix/other-machines\n',
					'/etc/nix/machines': 'ssh://ignored.example\n',
					'/etc/nix/other-machines': 'ssh://named.example\n'
				}
			},
			expected: { ...defaultBuilding, builders: 'ssh://named.example' }
		},
		{
			name: 'a builders setting mixing a file with a builder',
			fixture: {
				files: {
					'/etc/nix/nix.conf':
						'builders = @/etc/nix/machines ; ssh://direct.example\n',
					'/etc/nix/machines': 'ssh://listed.example\n'
				}
			},
			expected: {
				...defaultBuilding,
				builders: 'ssh://listed.example\nssh://direct.example'
			}
		},
		// The variable Nix reads for backwards compatibility names files, not
		// builders.
		{
			name: 'builders named by NIX_REMOTE_SYSTEMS',
			fixture: {
				env: { NIX_REMOTE_SYSTEMS: '/etc/nix/a:/etc/nix/b' },
				files: {
					'/etc/nix/machines': 'ssh://ignored.example\n',
					'/etc/nix/a': 'ssh://first.example\n',
					'/etc/nix/b': 'ssh://second.example\n'
				}
			},
			expected: {
				...defaultBuilding,
				builders: 'ssh://first.example\nssh://second.example'
			}
		},
		// Set but empty, the variable names no files, and the compiled-in
		// machines file is not consulted either.
		{
			name: 'an empty NIX_REMOTE_SYSTEMS, which names no builders at all',
			fixture: {
				env: { NIX_REMOTE_SYSTEMS: '' },
				files: { '/etc/nix/machines': 'ssh://ignored.example\n' }
			},
			expected: defaultBuilding
		},
		// Nix reads both `nix.conf` and the machines file from the directory
		// `NIX_CONF_DIR` names.
		{
			name: 'a machines file beside a relocated nix.conf',
			fixture: {
				env: { NIX_CONF_DIR: '/job/nix' },
				files: {
					'/etc/nix/machines': 'ssh://ignored.example\n',
					'/job/nix/machines': 'ssh://relocated.example\n'
				}
			},
			expected: { ...defaultBuilding, builders: 'ssh://relocated.example' }
		},
		// A `#` ends its line before the line splits on `;`, so a comment
		// takes the entries after it on the same line with it.
		{
			name: 'a machines file with an entry commented out mid-line',
			fixture: {
				files: {
					'/etc/nix/machines':
						'ssh://kept.example ; # ssh://dropped.example\nssh://also-kept.example\n'
				}
			},
			expected: {
				...defaultBuilding,
				builders: 'ssh://kept.example\nssh://also-kept.example'
			}
		},
		{
			name: 'a machines file listing two builders on one line',
			fixture: {
				files: {
					'/etc/nix/machines': 'ssh://one.example;ssh://two.example\n'
				}
			},
			expected: {
				...defaultBuilding,
				builders: 'ssh://one.example\nssh://two.example'
			}
		},
		// A machines file may name another, and Nix expands what it finds
		// there the same way.
		{
			name: 'a machines file naming another machines file',
			fixture: {
				files: {
					'/etc/nix/machines': '@/etc/nix/more\nssh://direct.example\n',
					'/etc/nix/more': 'ssh://nested.example\n'
				}
			},
			expected: {
				...defaultBuilding,
				builders: 'ssh://nested.example\nssh://direct.example'
			}
		},
		{
			name: 'a builders entry naming a file with space after the marker',
			fixture: {
				files: {
					'/etc/nix/nix.conf': 'builders = @ /etc/nix/spaced\n',
					'/etc/nix/spaced': 'ssh://spaced.example\n'
				}
			},
			expected: { ...defaultBuilding, builders: 'ssh://spaced.example' }
		},
		{
			name: 'a user file overriding the system file',
			fixture: {
				home: '/home/u',
				files: {
					'/etc/nix/nix.conf': 'builders = ssh://system.example\n',
					'/home/u/.config/nix/nix.conf': 'builders = ssh://user.example\n'
				}
			},
			expected: { ...defaultBuilding, builders: 'ssh://user.example' }
		}
	])('resolves the build settings from $name', ({ fixture, expected }) => {
		expect(discover(fixture).building).toStrictEqual(expected);
	});

	// A machines file naming itself would expand without end, so the chain of
	// them is followed only so far.
	it('refuses a machines file that names itself', () => {
		expect(() =>
			discover({ files: { '/etc/nix/machines': '@/etc/nix/machines\n' } })
		).toThrow(NixMachineFileError);
	});
});
