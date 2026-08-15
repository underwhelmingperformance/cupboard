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
	/** Files that are there and that this process may not read. */
	readonly unreadable?: readonly string[];
	readonly home?: string;
	/** The directory the fixture runs in. A relative path resolves against it. */
	readonly workingDirectory?: string;
	/** The machine the fixture discovers on, defaulting to an Apple silicon one. */
	readonly currentSystem?: () => string | undefined;
	/**
	 * What that machine offers a build. The default offers nothing beyond the
	 * portable names, so a fixture states the capability it is describing.
	 */
	readonly probes?: Partial<NixMachineProbes>;
}

/** The directory a fixture runs in by default. */
const defaultWorkingDirectory = '/work/dir';

// Nix reads a store reference in one of three ways: as a URI, as a word that
// names a store, or as a path. A path names a local store rooted at that path,
// and Nix writes it as a `local://` URI. Every setting that holds a store
// reference is resolved this way, so this table drives each of them.
const storeReferenceCases = [
	{
		name: 'an absolute path',
		written: '/var/cache/nix',
		resolved: 'local:///var/cache/nix'
	},
	{
		name: 'a path with a trailing separator',
		written: '/var/cache/nix/',
		resolved: 'local:///var/cache/nix'
	},
	{
		name: 'a path with repeated separators',
		written: '/var//cache///nix',
		resolved: 'local:///var/cache/nix'
	},
	{
		name: 'a path with a dot component',
		written: '/var/cache/nix/.',
		resolved: 'local:///var/cache/nix'
	},
	{
		name: 'a path with a double-dot component',
		written: '/var/cache/nix/..',
		resolved: 'local:///var/cache'
	},
	{ name: 'the root directory', written: '/', resolved: 'local:///' },
	{ name: 'a doubled leading separator', written: '//', resolved: 'local:///' },
	{
		name: 'a relative path',
		written: './cache',
		resolved: 'local:///work/dir/cache'
	},
	{
		name: 'a relative path above the working directory',
		written: '../cache',
		resolved: 'local:///work/cache'
	},
	{
		name: 'a relative path with no dot prefix',
		written: 'cache/nix',
		resolved: 'local:///work/dir/cache/nix'
	},
	{
		name: 'a tilde, which Nix does not expand',
		written: '~/cache',
		resolved: 'local:///work/dir/~/cache'
	},
	{
		name: 'a path with parameters',
		written: '/var/cache/nix?priority=7',
		resolved: 'local:///var/cache/nix?priority=7'
	},
	{
		name: 'a path with a trailing separator before its parameters',
		written: '/var/cache/nix/?priority=7',
		resolved: 'local:///var/cache/nix?priority=7'
	},
	{
		name: 'a path with an empty query',
		written: '/var/cache/nix?',
		resolved: 'local:///var/cache/nix'
	},
	{
		name: 'a path with a colon in it',
		written: '/var/cache:1/nix',
		resolved: 'local:///var/cache:1/nix'
	},
	{
		name: 'a local URI, which is already resolved',
		written: 'local:///var/cache/nix',
		resolved: 'local:///var/cache/nix'
	},
	{
		name: 'a file URI, which is a binary cache',
		written: 'file:///var/cache/nix',
		resolved: 'file:///var/cache/nix'
	},
	{
		name: 'an https URI',
		written: 'https://cache.example/',
		resolved: 'https://cache.example/'
	},
	{
		name: 'a scheme that opens no store here',
		written: 'weird://elsewhere',
		resolved: 'weird://elsewhere'
	},
	{ name: 'the daemon', written: 'daemon', resolved: 'daemon' },
	{ name: 'the automatic store', written: 'auto', resolved: 'auto' },
	{ name: 'the local store', written: 'local', resolved: 'local' }
];

/** A machine offering nothing a build can ask for beyond the portable names. */
const bareMachine: NixMachineProbes = {
	canReadWrite: () => false,
	fileExists: () => false,
	hasHardwareVirtualisation: () => false,
	isWsl1: () => false,
	microarchitectureLevels: () => []
};

/** What the filesystem raises for a file this process may not read. */
function permissionDenied(filePath: string): Error {
	return Object.assign(new Error(`EACCES: permission denied, ${filePath}`), {
		code: 'EACCES'
	});
}

function environmentFrom(fixture: Fixture): NixConfigEnvironment {
	return {
		env: fixture.env ?? {},
		readFile: (filePath) => {
			if (fixture.unreadable?.includes(filePath) === true) {
				throw permissionDenied(filePath);
			}

			return fixture.files?.[filePath];
		},
		homeDirectory: () => fixture.home,
		workingDirectory: () => fixture.workingDirectory ?? defaultWorkingDirectory,
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

// What an include failure states, or whatever was thrown when it is not one,
// so a case that throws something else reports what it threw.
function includeFailure(thrown: unknown): unknown {
	return thrown instanceof NixConfigIncludeError
		? { name: thrown.name, target: thrown.target, reason: thrown.reason }
		: thrown;
}

/** What a machine file failure states, on the same terms. */
function machineFileFailure(thrown: unknown): unknown {
	return thrown instanceof NixMachineFileError
		? { name: thrown.name, source: thrown.source, reason: thrown.reason }
		: thrown;
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

// The features each psABI level asks of a CPU, as libcpuid's
// `architecture_x86_64_v1` to `_v4` arrays state them and Linux spells them.
// Nix reads its levels from that library, so these are the arrays its answer
// comes from. Each level subsumes the one below it, so a CPU short of one
// feature of a level has none of the levels above it either.
const firstLevelFlags = ['cmov', 'cx8', 'fpu', 'fxsr', 'mmx', 'sse', 'sse2'];
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
	'movbe'
];
const fourthLevelFlags = [
	'avx512f',
	'avx512bw',
	'avx512cd',
	'avx512dq',
	'avx512vl'
];

const everyLevelFlags = [
	...firstLevelFlags,
	...secondLevelFlags,
	...thirdLevelFlags,
	...fourthLevelFlags
];

describe('microarchitectureLevelsOf', () => {
	it.each([
		// libcpuid reports a CPU short of the first level as an architecture it
		// has no name for, which leaves nix naming no level at all.
		{ name: 'no flags at all', flags: [], expected: [] },
		{
			name: 'the first level one flag short',
			flags: firstLevelFlags.slice(1),
			expected: []
		},
		{
			name: 'the first level',
			flags: firstLevelFlags,
			expected: ['x86_64-v1']
		},
		{
			name: 'the second level',
			flags: [...firstLevelFlags, ...secondLevelFlags],
			expected: ['x86_64-v1', 'x86_64-v2']
		},
		{
			name: 'the second level one flag short',
			flags: [...firstLevelFlags, ...secondLevelFlags.slice(1)],
			expected: ['x86_64-v1']
		},
		{
			name: 'the third level',
			flags: [...firstLevelFlags, ...secondLevelFlags, ...thirdLevelFlags],
			expected: ['x86_64-v1', 'x86_64-v2', 'x86_64-v3']
		},
		{
			name: 'the fourth level',
			flags: everyLevelFlags,
			expected: ['x86_64-v1', 'x86_64-v2', 'x86_64-v3', 'x86_64-v4']
		},
		{
			name: 'the fourth level without the third',
			flags: [...firstLevelFlags, ...secondLevelFlags, ...fourthLevelFlags],
			expected: ['x86_64-v1', 'x86_64-v2']
		}
	])('reports $name', ({ flags, expected }) => {
		expect(microarchitectureLevelsOf(new Set(flags))).toStrictEqual(expected);
	});

	// Linux may report that the CPU offers XSAVE while withholding AVX when
	// the operating system has not enabled the state AVX needs.
	it('does not infer the third level from xsave without avx', () => {
		const offered = [
			...everyLevelFlags.filter((flag) => flag !== 'avx'),
			'xsave'
		];

		expect(microarchitectureLevelsOf(new Set(offered))).toStrictEqual([
			'x86_64-v1',
			'x86_64-v2'
		]);
	});

	// Each level names exactly what libcpuid names, so a flag no level asks
	// for settles nothing.
	it.each(everyLevelFlags)('asks for %s', (flag) => {
		const short = everyLevelFlags.filter((offered) => offered !== flag);

		expect(microarchitectureLevelsOf(new Set(short))).not.toStrictEqual([
			'x86_64-v1',
			'x86_64-v2',
			'x86_64-v3',
			'x86_64-v4'
		]);
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
			signatures: defaultSignatureSettings,
			unknownSettings: []
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

	it('lets an empty store setting select auto over NIX_REMOTE', () => {
		const config = discover({
			env: { NIX_REMOTE: 'dummy://' },
			files: { '/etc/nix/nix.conf': 'store =\n' }
		});

		expect(config.storeUri).toBe('auto');
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
			signatures: defaultSignatureSettings,
			unknownSettings: []
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

	// Nix joins a relative include onto the directory of the file the line was
	// written in and then requires an absolute path. `NIX_CONFIG` is a value
	// rather than a file, so a relative target written there has no directory to
	// be joined onto and nix refuses the configuration.
	it('refuses a relative include written in NIX_CONFIG', () => {
		const thrown = includeFailure(
			thrownBy({
				env: { NIX_CONFIG: 'include extra.conf' },
				files: { 'extra.conf': 'store = local\n' }
			})
		);

		expect(thrown).toStrictEqual({
			name: 'NixConfigIncludeError',
			target: 'extra.conf',
			reason: 'not-an-absolute-path'
		});
	});

	it('follows an absolute include written in NIX_CONFIG', () => {
		const config = discover({
			env: { NIX_CONFIG: 'include /etc/nix/extra.conf' },
			files: { '/etc/nix/extra.conf': 'store = local\n' }
		});

		expect(config.storeUri).toBe('local');
	});

	// Nix reads a configuration file and an include that is there inside a
	// `try` that swallows whatever the filesystem says, so one this process may
	// not read leaves the settings where the rest of them stand.
	it.each<{ readonly name: string; readonly fixture: Fixture }>([
		{
			name: 'a system file',
			fixture: {
				files: { '/home/u/.config/nix/nix.conf': 'store = local\n' },
				unreadable: ['/etc/nix/nix.conf'],
				home: '/home/u'
			}
		},
		{
			name: 'an include it names',
			fixture: {
				files: { '/etc/nix/nix.conf': 'include extra.conf\nstore = local\n' },
				unreadable: ['/etc/nix/extra.conf']
			}
		}
	])('passes over $name that cannot be read', ({ fixture }) => {
		expect(discover(fixture).storeUri).toBe('local');
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
			'download-attempts': '3',
			'connect-timeout': '5',
			substituters: 'https://cache.nixos.org/ https://job.example',
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
			substituters:
				'https://system.example https://user.example https://job.example',
			'trusted-public-keys': 'system-1:key user-1:key job-1:key',
			'netrc-file': '/tmp/job-netrc'
		});
	});

	// Nix clears every setting's overridden mark once it has read the system
	// file, so a daemon is told what a user's own configuration said and
	// nothing the system file settled, however the value reached it.
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

	it('forwards an append to a Nix default as the list it resolves to', () => {
		const config = discover({
			env: {
				NIX_CONFIG: [
					'extra-substituters = https://job.example',
					'extra-trusted-public-keys = job-1:key'
				].join('\n')
			}
		});

		expect(config.daemonOverrides).toStrictEqual({
			substituters: 'https://cache.nixos.org/ https://job.example',
			'trusted-public-keys': `${defaultSignatureSettings.trustedPublicKeys.join(' ')} job-1:key`
		});
	});

	// A list this client resolves no default for states what it appends: a
	// daemon appends that to the list it holds, which is the list the append
	// was written against.
	it('forwards an append to a list it resolves no default for as an append', () => {
		const config = discover({
			env: {
				NIX_CONFIG: [
					'extra-sandbox-paths = /work',
					'extra-system-features = benchmark'
				].join('\n')
			}
		});

		expect(config.daemonOverrides).toStrictEqual({
			'extra-sandbox-paths': '/work',
			'extra-system-features': 'benchmark'
		});
	});

	// Nix accepts an `extra-` prefix only on a list setting, so an `extra-`
	// assignment to any other setting matches no setting and produces no daemon
	// override.
	it('forwards no override for an `extra-` assignment to a scalar setting', () => {
		const config = discover({
			env: {
				NIX_CONFIG: [
					'extra-netrc-file = /job/netrc',
					'extra-connect-timeout = 5'
				].join('\n')
			}
		});

		expect(config.daemonOverrides).toStrictEqual({});
	});

	it('forwards the key files a configuration signs with as it resolves them', () => {
		const config = discover({
			home: '/home/u',
			files: {
				'/etc/nix/nix.conf': 'secret-key-files = /etc/nix/system.key',
				'/home/u/.config/nix/nix.conf':
					'extra-secret-key-files = /home/u/user.key'
			}
		});

		expect(config.daemonOverrides).toStrictEqual({
			'secret-key-files': '/etc/nix/system.key /home/u/user.key'
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
			'download-attempts': '2',
			'narinfo-cache-negative-ttl': '0'
		});
	});

	// Nix renamed this setting and kept the older spelling as an alias, so a
	// configuration states it either way and means the same setting.
	it.each([
		{ name: 'the name nix released it under', setting: 'download-attempts' },
		{
			name: 'the name nix master gave it',
			setting: 'filetransfer-retry-attempts'
		}
	])('reads the transfer attempts from $name', ({ setting }) => {
		const config = discover({ env: { NIX_CONFIG: `${setting} = 9` } });

		expect(config.fileTransfer).toStrictEqual({
			...defaultFileTransferSettings,
			attempts: 9
		});
	});

	// A daemon knows this setting by the name nix released it under, whichever
	// spelling the configuration used, and one built from master knows that
	// name as an alias of its own.
	it.each([
		{ name: 'the released spelling', setting: 'download-attempts' },
		{ name: 'the master spelling', setting: 'filetransfer-retry-attempts' }
	])(
		'forwards the transfer attempts stated as $name by one name',
		({ setting }) => {
			const config = discover({ env: { NIX_CONFIG: `${setting} = 9` } });

			expect(config.daemonOverrides).toStrictEqual({
				'download-attempts': '9'
			});
		}
	);

	// The rest of the retry settings arrived with the rename, so no released
	// daemon has a name for them: this client reads them and tells a daemon
	// nothing about them.
	it('reads the retry settings nix master added without forwarding them', () => {
		const config = discover({
			env: {
				NIX_CONFIG: [
					'filetransfer-retry-delay = 250',
					'filetransfer-retry-delay-rate-limited = 9000',
					'filetransfer-retry-max-delay = 30000',
					'filetransfer-retry-jitter = false'
				].join('\n')
			}
		});

		expect({
			fileTransfer: config.fileTransfer,
			daemonOverrides: config.daemonOverrides
		}).toStrictEqual({
			fileTransfer: {
				...defaultFileTransferSettings,
				retryDelayMs: 250,
				rateLimitedRetryDelayMs: 9000,
				maxRetryDelayMs: 30_000,
				retryJitter: false
			},
			daemonOverrides: {}
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

	// Nix knows a setting by name and refuses the whole configuration over a
	// value the setting cannot hold, whether or not this client reads it for
	// anything of its own.
	it.each([
		{ name: 'a boolean spelling neither', line: 'keep-outputs = maybe' },
		{
			name: 'an experimental boolean spelling neither',
			line: 'accept-flake-config = maybe'
		},
		{ name: 'a boolean given a number above one', line: 'keep-outputs = 2' },
		{ name: 'a boolean written in another case', line: 'keep-outputs = True' },
		{ name: 'an integer that is a word', line: 'log-lines = many' },
		{ name: 'an integer written with a fraction', line: 'log-lines = 1.5' },
		{ name: 'an integer written in hex', line: 'log-lines = 0x10' },
		{ name: 'an integer among other words', line: 'log-lines = 10 20' },
		{ name: 'the word only one setting takes', line: 'cores = auto' }
	])('refuses a setting it does not read carrying $name', ({ line }) => {
		expect(thrownBy({ env: { NIX_CONFIG: line } })).toBeInstanceOf(
			NixConfigSettingError
		);
	});

	// Nix reads these, so a configuration carrying one is a configuration to
	// carry on with.
	it.each([
		{ name: 'a boolean nix spells true', line: 'keep-outputs = yes' },
		{ name: 'an integer', line: 'log-lines = 10' },
		{ name: 'an integer written with a sign', line: 'log-lines = +5' },
		// Nix declares a few of its integer settings signed, and which they are
		// is not something the settings table carries.
		{ name: 'a negative integer', line: 'gc-reserved-space = -1' },
		{ name: 'the parallelism max-jobs takes', line: 'max-jobs = auto' },
		// A string, a list and a map are read by shapes the table does not
		// carry, so the value stands as it is written.
		{ name: 'a key that is not a key', line: 'trusted-public-keys = garbage' },
		{ name: 'a map entry that is not one', line: 'access-tokens = nonsense' }
	])('reads a configuration carrying $name', ({ line }) => {
		expect(thrownBy({ env: { NIX_CONFIG: line } })).toBeUndefined();
	});

	// Nix reads a few of its settings by a shape the kind of value cannot
	// carry: a path from the filesystem root, and a store it could open.
	it.each([
		{
			name: 'a netrc file that is not an absolute path',
			line: 'netrc-file = netrc'
		},
		{ name: 'an empty netrc file', line: 'netrc-file = ' },
		{
			name: 'a certificate file that is not an absolute path',
			line: 'ssl-cert-file = certs/ca.pem'
		},
		{ name: 'a substituter naming no store', line: 'substituters = notastore' },
		{
			name: 'one substituter of several naming no store',
			line: 'substituters = https://ok.example/ notastore'
		},
		{
			name: 'a trusted substituter naming no store',
			line: 'trusted-substituters = notastore'
		}
	])('refuses $name', ({ line }) => {
		expect(thrownBy({ env: { NIX_CONFIG: line } })).toBeInstanceOf(
			NixConfigSettingError
		);
	});

	// A store reference is a URI, one of the names nix has for a store, or a
	// path to one. A scheme nix has no store for is read all the same: what
	// refuses that is opening the store, not reading the setting.
	it.each([
		{ name: 'an absolute path', value: '/var/cache/nix' },
		{ name: 'a relative path', value: './cache' },
		{ name: 'a URL', value: 'https://cache.example/' },
		{ name: 'a scheme with no store behind it', value: 'weird://elsewhere' },
		{ name: 'the automatic store', value: 'auto' },
		{ name: 'the daemon', value: 'daemon' },
		{ name: 'the local store', value: 'local' },
		{ name: 'a local store naming a root', value: 'local?root=/rooted' },
		{ name: 'no substituter at all', value: '' }
	])('reads a substituter named as $name', ({ value }) => {
		expect(
			thrownBy({ env: { NIX_CONFIG: `substituters = ${value}` } })
		).toBeUndefined();
	});

	// Nix counts the silent time in a signed width, so it reads a negative
	// there and refuses one for the settings it counts unsigned.
	it('reads a negative silent time as the number it states', () => {
		const config = discover({ env: { NIX_CONFIG: 'max-silent-time = -1' } });

		expect(config.daemonSetOptions).toStrictEqual({ maxSilentTime: -1 });
	});

	it.each([
		{ name: 'the number of cores', line: 'cores = -4' },
		{ name: 'the number of jobs', line: 'max-jobs = -1' }
	])('refuses a negative $name', ({ line }) => {
		expect(thrownBy({ env: { NIX_CONFIG: line } })).toBeInstanceOf(
			NixConfigSettingError
		);
	});

	// Nix warns about a name it has no setting for and carries on, so the
	// configuration stands and the name is reported rather than acted on.
	it('reports a setting name Nix does not have, and reads the remaining settings', () => {
		const config = discover({
			env: {
				NIX_CONFIG: [
					'no-such-setting = 1',
					'extra-cores = 4',
					'connect-timeout = 5'
				].join('\n')
			}
		});

		expect({
			unknownSettings: config.unknownSettings,
			daemonOverrides: config.daemonOverrides
		}).toStrictEqual({
			unknownSettings: ['extra-cores', 'no-such-setting'],
			daemonOverrides: { 'connect-timeout': '5' }
		});
	});

	it('recognises a setting nix reads behind an experimental feature', () => {
		const config = discover({
			env: { NIX_CONFIG: 'impure-env = FOO=bar' }
		});

		expect({
			unknownSettings: config.unknownSettings,
			daemonOverrides: config.daemonOverrides
		}).toStrictEqual({
			unknownSettings: [],
			daemonOverrides: { 'impure-env': 'FOO=bar' }
		});
	});

	// A setting this client reads under the name Nix master gave it is still a
	// valid setting, whatever the pinned Nix calls it.
	it('reads a setting that only Nix master defines', () => {
		const config = discover({
			env: { NIX_CONFIG: 'filetransfer-retry-delay = 250' }
		});

		expect({
			unknownSettings: config.unknownSettings,
			retryDelayMs: config.fileTransfer.retryDelayMs
		}).toStrictEqual({ unknownSettings: [], retryDelayMs: 250 });
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
			// Nix holds the substituters as a list, so one named twice is held
			// twice and the resolved setting says so.
			name: 'a substituter listed twice',
			fixture: {
				files: {
					'/etc/nix/nix.conf':
						'substituters = https://one.example https://one.example\n'
				}
			},
			expected: {
				...defaultSubstitution,
				substituters: ['https://one.example', 'https://one.example']
			}
		},
		{
			name: 'a substituter appended after the list already names it',
			fixture: {
				files: {
					'/etc/nix/nix.conf': 'substituters = https://one.example\n'
				},
				env: { NIX_CONFIG: 'extra-substituters = https://one.example' }
			},
			expected: {
				...defaultSubstitution,
				substituters: ['https://one.example', 'https://one.example']
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

	it.each(storeReferenceCases)(
		'resolves a substituter written as $name',
		({ written, resolved }) => {
			const fixture = {
				files: { '/etc/nix/nix.conf': `substituters = ${written}\n` }
			};

			expect(discover(fixture).substitution.substituters).toStrictEqual([
				resolved
			]);
		}
	);

	it.each(storeReferenceCases)(
		'resolves a store setting written as $name',
		({ written, resolved }) => {
			const fixture = {
				files: { '/etc/nix/nix.conf': `store = ${written}\n` }
			};

			expect(discover(fixture).storeUri).toBe(resolved);
		}
	);

	// Nix reads an integer setting as a sign, digits and an optional binary
	// unit, and bounds it by the width it declared the setting with.
	it.each([
		{ name: 'a plain count', written: '7', expected: 7 },
		{ name: 'a kibi unit', written: '1K', expected: 1024 },
		{ name: 'a kibi unit in lower case', written: '1k', expected: 1024 },
		{ name: 'a mebi unit', written: '1M', expected: 1024 * 1024 },
		{ name: 'a gibi unit', written: '1G', expected: 1024 ** 3 },
		{ name: 'a tebi unit', written: '1T', expected: 1024 ** 4 },
		{ name: 'a multiplied count', written: '2K', expected: 2048 },
		{ name: 'a signed count', written: '+7', expected: 7 },
		{ name: 'a leading zero', written: '07', expected: 7 },
		{
			// The widest value the setting holds reaches past the range a number
			// states exactly, so it is held to the nearest one. Nothing this
			// client acts on comes near it.
			name: 'the widest value the setting holds',
			written: '18446744073709551615',
			expected: Number(2n ** 64n - 1n)
		}
	])('reads $name in http-connections', ({ written, expected }) => {
		const fixture = {
			files: { '/etc/nix/nix.conf': `http-connections = ${written}\n` }
		};

		expect(discover(fixture).fileTransfer.httpConnections).toBe(expected);
	});

	it.each([
		{
			name: 'a unit nix has none of',
			setting: 'http-connections',
			written: '1P'
		},
		{
			name: 'a unit with more after it',
			setting: 'http-connections',
			written: '1KB'
		},
		{
			name: 'a unit set apart from its number',
			setting: 'http-connections',
			written: '1 K'
		},
		{ name: 'another base', setting: 'http-connections', written: '0x10' },
		{ name: 'a fraction', setting: 'http-connections', written: '1.5' },
		{
			name: 'a negative for a setting nix counts unsigned',
			setting: 'http-connections',
			written: '-1'
		},
		{
			name: 'a negative unit for a setting nix counts unsigned',
			setting: 'http-connections',
			written: '-1K'
		},
		{
			name: 'a value above the width nix declared',
			setting: 'cores',
			written: '4294967296'
		},
		{
			name: 'a count above that width even with a unit after it',
			setting: 'cores',
			written: '4294967296K'
		}
	])('refuses $name', ({ setting, written }) => {
		const fixture = {
			files: { '/etc/nix/nix.conf': `${setting} = ${written}\n` }
		};

		expect(thrownBy(fixture)).toBeInstanceOf(NixConfigSettingError);
	});

	// A width nix counts signed takes a negative, with or without a unit.
	it.each([
		{ name: 'a negative', written: '-1', expected: -1 },
		{ name: 'a negative with a unit', written: '-1K', expected: -1024 },
		{
			name: 'the widest value the setting holds',
			written: '4294967295',
			expected: 4_294_967_295
		}
	])('reads $name in max-silent-time', ({ written, expected }) => {
		const fixture = {
			files: { '/etc/nix/nix.conf': `max-silent-time = ${written}\n` }
		};

		expect(discover(fixture).daemonSetOptions.maxSilentTime).toBe(expected);
	});

	it('reads a unit in a setting the daemon frame carries', () => {
		const fixture = { files: { '/etc/nix/nix.conf': 'cores = 4M\n' } };

		expect(discover(fixture).daemonSetOptions.buildCores).toBe(4_194_304);
	});

	// Nix reads the digits into the declared width, then multiplies, and holds
	// the product in that same width, which wraps.
	it.each([
		{ name: 'a whole number of widths', written: '1T', expected: 0 },
		{
			name: 'past the width by part of one',
			written: '4294967295K',
			expected: 4_294_966_272
		}
	])('wraps a count multiplied $name', ({ written, expected }) => {
		const fixture = { files: { '/etc/nix/nix.conf': `cores = ${written}\n` } };

		expect(discover(fixture).daemonSetOptions.buildCores).toBe(expected);
	});

	it('resolves a path in NIX_REMOTE to the store it names', () => {
		expect(discover({ env: { NIX_REMOTE: '/var/cache/nix' } }).storeUri).toBe(
			'local:///var/cache/nix'
		);
	});

	it('resolves every substituter in a list and keeps the order', () => {
		const fixture = {
			files: {
				'/etc/nix/nix.conf':
					'substituters = https://one.example /var/cache/nix daemon ./cache\n'
			}
		};

		expect(discover(fixture).substitution.substituters).toStrictEqual([
			'https://one.example',
			'local:///var/cache/nix',
			'daemon',
			'local:///work/dir/cache'
		]);
	});

	it('forwards a path-shaped substituter to a daemon as a local URI', () => {
		const fixture = {
			env: { NIX_CONFIG: 'substituters = /var/cache/nix' }
		};

		expect(discover(fixture).daemonOverrides).toStrictEqual({
			substituters: 'local:///var/cache/nix'
		});
	});

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
		},
		{
			// Nix holds both of these as lists, so a key or a file stated twice
			// is held twice.
			name: 'a trusted key and a secret key file each stated twice',
			fixture: {
				files: {
					'/etc/nix/nix.conf': [
						'trusted-public-keys = mine-1:key mine-1:key',
						'secret-key-files = /etc/nix/a /etc/nix/a'
					].join('\n')
				}
			},
			expected: {
				...defaultSignatureSettings,
				trustedPublicKeys: ['mine-1:key', 'mine-1:key'],
				secretKeyFiles: ['/etc/nix/a', '/etc/nix/a']
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
			// Nix holds the platforms and the features as sets, so neither a
			// repeated name nor one appended over itself names a second.
			name: 'a platform and a feature each stated twice',
			fixture: {
				files: {
					'/etc/nix/nix.conf': [
						'extra-platforms = x86_64-darwin x86_64-darwin',
						'system-features = kvm kvm',
						'extra-system-features = kvm'
					].join('\n')
				}
			},
			expected: {
				...defaultBuilding,
				systems: ['aarch64-darwin', 'x86_64-darwin'],
				features: ['kvm']
			}
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

	// Nix passes over a machines file that is not there and raises whatever
	// else the filesystem said about one, so a file it may not read is a
	// configuration it cannot resolve rather than a list of no builders.
	it('refuses a machines file that cannot be read', () => {
		const thrown = machineFileFailure(
			thrownBy({
				files: { '/etc/nix/nix.conf': 'builders = @/etc/nix/machines\n' },
				unreadable: ['/etc/nix/machines']
			})
		);

		expect(thrown).toStrictEqual({
			name: 'NixMachineFileError',
			source: '/etc/nix/machines',
			reason: 'file-could-not-be-read'
		});
	});

	it('reports no builders for a machines file that does not exist', () => {
		const config = discover({
			files: { '/etc/nix/nix.conf': 'builders = @/etc/nix/machines\n' }
		});

		expect(config.building).toStrictEqual(defaultBuilding);
	});
});
