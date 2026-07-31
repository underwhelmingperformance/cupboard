import { availableParallelism } from 'node:os';

import { storeDirectoryMaxLength } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	InvalidNixStoreDirectoryError,
	NixConfigIncludeError,
	NixConfigSettingError
} from './nix-store.ts';
import {
	discoverNixStoreConfig,
	type NixConfigEnvironment,
	type NixStoreConfig
} from './store-config.ts';

interface Fixture {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly files?: Readonly<Record<string, string>>;
	readonly home?: string;
}

function environmentFrom(fixture: Fixture): NixConfigEnvironment {
	return {
		env: fixture.env ?? {},
		readFile: (filePath) => fixture.files?.[filePath],
		homeDirectory: () => fixture.home
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

describe('discoverNixStoreConfig', () => {
	it('falls back to the compiled defaults with no configuration', () => {
		expect(discover({})).toStrictEqual({
			storeUri: 'auto',
			storeDirectory: '/nix/store',
			stateDirectory: '/nix/var/nix',
			daemonSocketPath: '/nix/var/nix/daemon-socket/socket',
			daemonSetOptions: {},
			daemonOverrides: {}
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

	it('lets the user file override the system file', () => {
		const config = discover({
			home: '/home/u',
			files: {
				'/etc/nix/nix.conf': 'store-dir = /system/store\n',
				'/home/u/.config/nix/nix.conf': 'store-dir = /user/store\n'
			}
		});

		expect(config.storeDirectory).toBe('/user/store');
	});

	it('lets NIX_STORE_DIR override the store-dir setting', () => {
		const config = discover({
			env: { NIX_STORE_DIR: '/env/store' },
			files: { '/etc/nix/nix.conf': 'store-dir = /file/store\n' }
		});

		expect(config.storeDirectory).toBe('/env/store');
	});

	it('derives the socket path from NIX_STATE_DIR', () => {
		const config = discover({ env: { NIX_STATE_DIR: '/srv/nix' } });

		expect(config).toStrictEqual({
			storeUri: 'auto',
			storeDirectory: '/nix/store',
			stateDirectory: '/srv/nix',
			daemonSocketPath: '/srv/nix/daemon-socket/socket',
			daemonSetOptions: {},
			daemonOverrides: {}
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
			'download-attempts': '2',
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
			name: 'a parent segment in NIX_STORE_DIR',
			fixture: { env: { NIX_STORE_DIR: '/nix/../store' } },
			storeDirectory: '/nix/../store',
			source: 'NIX_STORE_DIR'
		},
		{
			name: 'a current segment in NIX_STORE_DIR',
			fixture: { env: { NIX_STORE_DIR: '/nix/./store' } },
			storeDirectory: '/nix/./store',
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
			name: 'a relative store-dir setting',
			fixture: { files: { '/etc/nix/nix.conf': 'store-dir = ../store\n' } },
			storeDirectory: '../store',
			source: 'store-dir'
		},
		{
			name: 'an empty store-dir setting',
			fixture: { files: { '/etc/nix/nix.conf': 'store-dir =\n' } },
			storeDirectory: '',
			source: 'store-dir'
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
});
