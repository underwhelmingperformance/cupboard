import { describe, expect, it } from 'vitest';

import { NixConfigIncludeError } from './nix-store.ts';
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
});
