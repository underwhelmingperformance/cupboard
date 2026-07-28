import { storeDirectoryMaxLength } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	InvalidNixStoreDirectoryError,
	NixConfigIncludeError
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
			daemonSocketPath: '/nix/var/nix/daemon-socket/socket'
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
			daemonSocketPath: '/srv/nix/daemon-socket/socket'
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
