import { storePathSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it, vi } from 'vitest';

import { FakeDaemonChild } from '../../../tests/support/fake-daemon-child.ts';
import { FakeDaemonTransport } from '../../../tests/support/fake-daemon-transport.ts';

import { NixDaemonStoreClient } from './nix-daemon.ts';
import type { DaemonCommandRunner } from './nix-daemon-process.ts';
import {
	createSshNixDaemonConnector,
	parseSshNgStoreUri
} from './nix-daemon-ssh.ts';

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);

describe('parseSshNgStoreUri', () => {
	it.each([
		{
			name: 'a destination with a user',
			uri: 'ssh-ng://build@example.test',
			expected: { destination: 'build@example.test', host: 'example.test' }
		},
		{
			name: 'a bare host',
			uri: 'ssh-ng://example.test',
			expected: { destination: 'example.test', host: 'example.test' }
		},
		{
			name: 'an IPv6 host',
			uri: 'ssh-ng://build@[2001:db8::1]:2222',
			expected: {
				destination: 'build@2001:db8::1',
				host: '2001:db8::1',
				port: 2222
			}
		},
		{
			name: 'a percent-encoded host',
			uri: 'ssh-ng://build@%65xample.test',
			expected: {
				destination: 'build@example.test',
				host: 'example.test'
			}
		},
		{
			name: 'an authority port and SSH settings',
			uri: 'ssh-ng://build@example.test:2222?ssh-key=%2Frun%2Fkey&base64-ssh-public-host-key=c3NoLWVkMjU1MTkgQUFBQQ%3D%3D&compress=true',
			expected: {
				destination: 'build@example.test',
				host: 'example.test',
				port: 2222,
				sshKey: '/run/key',
				sshPublicHostKey: 'ssh-ed25519 AAAA',
				compress: true
			}
		},
		{
			name: 'a remote-program parameter',
			uri: 'ssh-ng://example.test?remote-program=/opt/nix/bin/nix-daemon%20--option',
			expected: {
				destination: 'example.test',
				host: 'example.test',
				remoteProgram: ['/opt/nix/bin/nix-daemon', '--option']
			}
		},
		{
			name: 'a remote program whose plus is literal and a remote store',
			uri: 'ssh-ng://example.test?remote-program=nix-daemon+wrapped&remote-store=local%3Fstore%3D%2Fremote%2Fstore',
			expected: {
				destination: 'example.test',
				host: 'example.test',
				remoteProgram: ['nix-daemon+wrapped'],
				remoteStore: 'local?store=/remote/store'
			}
		},
		{ name: 'an empty destination', uri: 'ssh-ng://', expected: undefined },
		{
			name: 'a host starting with an option marker',
			uri: 'ssh-ng://-oProxyCommand=bad',
			expected: undefined
		},
		{
			name: 'a user starting with an option marker',
			uri: 'ssh-ng://-build@example.test',
			expected: undefined
		},
		{
			name: 'a different scheme',
			uri: 'ssh://example.test',
			expected: undefined
		}
	])('parses $name', ({ uri, expected }) => {
		expect(parseSshNgStoreUri(uri)).toStrictEqual(expected);
	});
});

describe('createSshNixDaemonConnector', () => {
	it.each([
		{
			name: 'the default remote program',
			spec: { destination: 'build@example.test' },
			expectedArguments: [
				'build@example.test',
				'-x',
				'--',
				'nix-daemon',
				'--stdio'
			]
		},
		{
			name: 'a configured remote program',
			spec: {
				destination: 'example.test',
				remoteProgram: ['/opt/nix/bin/nix-daemon', '--option'],
				remoteStore: 'local?store=/remote/store'
			},
			expectedArguments: [
				'example.test',
				'-x',
				'--',
				'/opt/nix/bin/nix-daemon',
				'--option',
				'--store',
				'local?store=/remote/store',
				'--stdio'
			]
		}
	])('starts ssh with $name', async ({ spec, expectedArguments }) => {
		const commands: {
			command: string;
			commandArguments: readonly string[];
		}[] = [];
		const run: DaemonCommandRunner = (command, commandArguments) => {
			commands.push({ command, commandArguments });

			return new FakeDaemonChild(new FakeDaemonTransport({}));
		};
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(spec, run)
		});

		await expect(client.queryValidPaths([appPath])).resolves.toStrictEqual([]);
		expect(commands).toStrictEqual([
			{ command: 'ssh', commandArguments: expectedArguments }
		]);
	});

	it('applies shell-split NIX_SSHOPTS and the store SSH settings', async () => {
		const commands: string[][] = [];
		const knownHosts: { host: string; publicKey: string }[] = [];
		const run: DaemonCommandRunner = (_command, commandArguments) => {
			commands.push([...commandArguments]);

			return new FakeDaemonChild(new FakeDaemonTransport({}));
		};
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(
				{
					destination: 'build@example.test',
					host: 'example.test',
					port: 2222,
					sshKey: '/run/store key',
					sshPublicHostKey: 'ssh-ed25519 AAAA',
					compress: true
				},
				run,
				{
					env: { NIX_SSHOPTS: '-F "/run/ssh config" -o BatchMode=yes' },
					knownHostsFile: (host, publicKey) => {
						knownHosts.push({ host, publicKey });

						return { path: '/tmp/known-hosts', dispose: vi.fn() };
					}
				}
			)
		});

		await expect(client.queryValidPaths([appPath])).resolves.toStrictEqual([]);
		expect({ commands, knownHosts }).toStrictEqual({
			commands: [
				[
					'build@example.test',
					'-x',
					'-oUserKnownHostsFile=/tmp/known-hosts',
					'-oStrictHostKeyChecking=yes',
					'-oGlobalKnownHostsFile=/dev/null',
					'-F',
					'/run/ssh config',
					'-o',
					'BatchMode=yes',
					'-i',
					'/run/store key',
					'-C',
					'-p2222',
					'--',
					'nix-daemon',
					'--stdio'
				]
			],
			knownHosts: [
				{ host: '[example.test]:2222', publicKey: 'ssh-ed25519 AAAA' }
			]
		});
	});

	it.each([
		{
			name: 'an explicit default port',
			destination: 'build@example.test',
			host: 'example.test',
			port: 22,
			expected: 'example.test'
		},
		{
			name: 'an IPv6 host and nonstandard port',
			destination: 'build@2001:db8::1',
			host: '2001:db8::1',
			port: 2222,
			expected: '[2001:db8::1]:2222'
		}
	])('pins $name with known_hosts syntax', async (fixture) => {
		const knownHosts: string[] = [];
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(
				{
					destination: fixture.destination,
					host: fixture.host,
					port: fixture.port,
					sshPublicHostKey: 'ssh-ed25519 AAAA'
				},
				() => new FakeDaemonChild(new FakeDaemonTransport({})),
				{
					knownHostsFile: (host) => {
						knownHosts.push(host);

						return { path: '/tmp/known-hosts', dispose: vi.fn() };
					}
				}
			)
		});

		await expect(client.queryValidPaths([appPath])).resolves.toStrictEqual([]);
		expect(knownHosts).toStrictEqual([fixture.expected]);
	});

	it('shell-splits quotes and escapes the way Nix does', async () => {
		const commands: string[][] = [];
		const run: DaemonCommandRunner = (_command, commandArguments) => {
			commands.push([...commandArguments]);

			return new FakeDaemonChild(new FakeDaemonTransport({}));
		};
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(
				{ destination: 'example.test' },
				run,
				{
					env: {
						NIX_SSHOPTS:
							'-o "ProxyCommand=echo\\ q" -o IdentityAgent=one\\ two\nthree'
					}
				}
			)
		});

		await expect(client.queryValidPaths([appPath])).resolves.toStrictEqual([]);
		expect(commands).toStrictEqual([
			[
				'example.test',
				'-x',
				'-o',
				String.raw`ProxyCommand=echo\ q`,
				'-o',
				'IdentityAgent=one two\nthree',
				'--',
				'nix-daemon',
				'--stdio'
			]
		]);
	});

	it('removes a generated host-key file when ssh cannot start', async () => {
		const dispose = vi.fn();
		const failure = new Error('ssh cannot start');
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(
				{
					destination: 'example.test',
					host: 'example.test',
					sshPublicHostKey: 'ssh-ed25519 AAAA'
				},
				() => {
					throw failure;
				},
				{
					knownHostsFile: () => ({ path: '/tmp/known-hosts', dispose })
				}
			)
		});

		await expect(client.queryValidPaths([appPath])).rejects.toBe(failure);
		expect(dispose).toHaveBeenCalledOnce();
	});
});
