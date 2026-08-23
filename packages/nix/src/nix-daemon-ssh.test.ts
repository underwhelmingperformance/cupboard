import { storePathSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it, vi } from 'vitest';

import {
	FakeByteSource,
	FakeDaemonChild
} from '../../../tests/support/fake-daemon-child.ts';
import { FakeDaemonTransport } from '../../../tests/support/fake-daemon-transport.ts';
import { ProtocolWriter } from '../../../tests/support/protocol-writer.ts';

import { NixDaemonStoreClient } from './nix-daemon.ts';
import type {
	DaemonChildProcess,
	DaemonCommandRunner
} from './nix-daemon-process.ts';
import {
	createSshNixDaemonConnector,
	parseSshNgStoreUri
} from './nix-daemon-ssh.ts';

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const libraryPath = storePathSchema.parse(
	'/nix/store/1123456789abcdfghijklmnpqrsvwxyz-library'
);
const runtimePath = storePathSchema.parse(
	'/nix/store/2123456789abcdfghijklmnpqrsvwxyz-runtime'
);
const appDrvPath = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-app.drv'
);
const libraryDrvPath = storePathSchema.parse(
	'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-library.drv'
);

class StalledHandshakeChild implements DaemonChildProcess {
	private exitListener: ((error: Error) => void) | undefined;

	readonly stdout = new FakeByteSource();

	killed = 0;

	readonly stdin = {
		write: (
			_chunk: Uint8Array,
			callback: (error?: Error | null) => void
		): void => {
			callback();
		}
	};

	once(event: 'exit' | 'error', listener: (error: Error) => void): void {
		if (event === 'exit') {
			this.exitListener = listener;
		}
	}

	kill(): void {
		this.killed += 1;
		this.exitListener?.(new Error('child exited'));
	}
}

describe('parseSshNgStoreUri', () => {
	it.each([
		{
			name: 'parses a destination with a user',
			uri: 'ssh-ng://build@example.test',
			expected: { destination: 'build@example.test', host: 'example.test' }
		},
		{
			name: 'parses a bare host',
			uri: 'ssh-ng://example.test',
			expected: { destination: 'example.test', host: 'example.test' }
		},
		{
			name: 'parses the native localhost authority',
			uri: 'ssh-ng://localhost',
			expected: {
				destination: 'localhost',
				host: 'localhost',
				isNativeLocalhost: true
			}
		},
		{
			name: 'parses a localhost authority encoded the way Nix normalises',
			uri: 'ssh-ng://%6cocalhost:',
			expected: {
				destination: 'localhost',
				host: 'localhost',
				isNativeLocalhost: true
			}
		},
		{
			name: 'parses an IPv6 host',
			uri: 'ssh-ng://build@[2001:db8::1]:2222',
			expected: {
				destination: 'build@2001:db8::1',
				host: '2001:db8::1',
				port: 2222
			}
		},
		{
			name: 'parses a percent-encoded host',
			uri: 'ssh-ng://build@%65xample.test',
			expected: {
				destination: 'build@example.test',
				host: 'example.test'
			}
		},
		{
			name: 'parses an authority port and SSH settings',
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
			name: 'parses the maximum authority port',
			uri: 'ssh-ng://example.test:65535',
			expected: {
				destination: 'example.test',
				host: 'example.test',
				port: 65_535
			}
		},
		{
			name: 'parses an explicitly empty authority port',
			uri: 'ssh-ng://example.test:',
			expected: { destination: 'example.test', host: 'example.test' }
		},
		{
			name: 'parses an authority with an ignored password subcomponent',
			uri: 'ssh-ng://build:ignored@example.test',
			expected: {
				destination: 'build@example.test',
				host: 'example.test'
			}
		},
		{
			name: 'parses a URI with an ignored fragment',
			uri: 'ssh-ng://build@example.test#not-part-of-the-store',
			expected: {
				destination: 'build@example.test',
				host: 'example.test'
			}
		},
		{
			name: 'parses a remote-program parameter',
			uri: 'ssh-ng://example.test?remote-program=/opt/nix/bin/nix-daemon%20--option',
			expected: {
				destination: 'example.test',
				host: 'example.test',
				remoteProgram: ['/opt/nix/bin/nix-daemon', '--option']
			}
		},
		{
			name: 'parses an explicitly empty remote program',
			uri: 'ssh-ng://example.test?remote-program=',
			expected: {
				destination: 'example.test',
				host: 'example.test',
				remoteProgram: []
			}
		},
		{
			name: 'parses a whitespace-only remote program',
			uri: 'ssh-ng://example.test?remote-program=%20%20',
			expected: {
				destination: 'example.test',
				host: 'example.test',
				remoteProgram: []
			}
		},
		{
			name: 'parses a configured connection limit',
			uri: 'ssh-ng://example.test?max-connections=3',
			expected: {
				destination: 'example.test',
				host: 'example.test',
				maxConnections: 3
			}
		},
		{
			name: 'parses a configured connection age',
			uri: 'ssh-ng://example.test?max-connection-age=90',
			expected: {
				destination: 'example.test',
				host: 'example.test',
				maxConnectionAge: 90
			}
		},
		{
			name: 'clamps a non-positive connection limit to one',
			uri: 'ssh-ng://example.test?max-connections=-2',
			expected: {
				destination: 'example.test',
				host: 'example.test',
				maxConnections: 1
			}
		},
		{
			name: 'preserves a literal plus in the remote program and parses the remote store',
			uri: 'ssh-ng://example.test?remote-program=nix-daemon+wrapped&remote-store=local%3Fstore%3D%2Fremote%2Fstore',
			expected: {
				destination: 'example.test',
				host: 'example.test',
				remoteProgram: ['nix-daemon+wrapped'],
				remoteStore: 'local?store=/remote/store'
			}
		},
		{
			name: 'refuses an empty destination',
			uri: 'ssh-ng://',
			expected: undefined
		},
		{
			name: 'refuses an explicit empty user',
			uri: 'ssh-ng://@example.test',
			expected: undefined
		},
		{
			name: 'refuses an explicit empty user with a password',
			uri: 'ssh-ng://:ignored@example.test',
			expected: undefined
		},
		{
			name: 'refuses a path after the authority',
			uri: 'ssh-ng://example.test/remote-store',
			expected: undefined
		},
		{
			name: 'refuses a trailing authority slash',
			uri: 'ssh-ng://example.test/',
			expected: undefined
		},
		{
			name: 'refuses port zero',
			uri: 'ssh-ng://example.test:0',
			expected: undefined
		},
		{
			name: 'refuses an authority port above the maximum',
			uri: 'ssh-ng://example.test:65536',
			expected: undefined
		},
		{
			name: 'refuses a host starting with an option marker',
			uri: 'ssh-ng://-oProxyCommand=bad',
			expected: undefined
		},
		{
			name: 'refuses a user starting with an option marker',
			uri: 'ssh-ng://-build@example.test',
			expected: undefined
		},
		{
			name: 'refuses a different scheme',
			uri: 'ssh://example.test',
			expected: undefined
		}
	])('$name', ({ uri, expected }) => {
		expect(parseSshNgStoreUri(uri)).toStrictEqual(expected);
	});

	it.each(['1.5', 'many', '2147483648'])(
		'refuses an invalid max-connections value of %s',
		(value) => {
			expect(() =>
				parseSshNgStoreUri(`ssh-ng://example.test?max-connections=${value}`)
			).toThrow(
				`Nix configuration setting 'max-connections' has invalid value '${value}'`
			);
		}
	);

	it.each(['-1', '1.5', 'many', '4294967296'])(
		'refuses an invalid max-connection-age value of %s',
		(value) => {
			expect(() =>
				parseSshNgStoreUri(`ssh-ng://example.test?max-connection-age=${value}`)
			).toThrow(
				`Nix configuration setting 'max-connection-age' has invalid value '${value}'`
			);
		}
	);

	it('reports an invalid base64-ssh-public-host-key value', () => {
		expect(() =>
			parseSshNgStoreUri(
				'ssh-ng://example.test?base64-ssh-public-host-key=not-base64'
			)
		).toThrow(
			"Nix configuration setting 'base64-ssh-public-host-key' is not valid base64"
		);
	});

	it('accepts a base64 host key with a long padding suffix', () => {
		const encoded = encodeURIComponent(`QQ${'='.repeat(10_000)}`);

		expect(
			parseSshNgStoreUri(
				`ssh-ng://example.test?base64-ssh-public-host-key=${encoded}`
			)
		).toMatchObject({ sshPublicHostKey: 'A' });
	});
});

describe('createSshNixDaemonConnector', () => {
	it('closing one concurrent daemon connection leaves the other SSH transport open', async () => {
		const commands: string[][] = [];
		const disposeKnownHosts = [vi.fn(), vi.fn()];
		let knownHostsIndex = 0;
		const connector = createSshNixDaemonConnector(
			{
				destination: 'build@example.test',
				host: 'example.test',
				sshPublicHostKey: 'ssh-ed25519 AAAA'
			},
			(_command, commandArguments) => {
				commands.push([...commandArguments]);

				return new FakeDaemonChild(new FakeDaemonTransport({}));
			},
			{
				knownHostsFile: () => ({
					path: `/tmp/cupboard-known-hosts-${String(knownHostsIndex)}`,
					dispose: disposeKnownHosts[knownHostsIndex++] ?? vi.fn()
				})
			}
		);

		const first = await connector('', undefined);
		const second = await connector('', undefined);

		expect(commands).toStrictEqual([
			[
				'build@example.test',
				'-x',
				'-oUserKnownHostsFile=/tmp/cupboard-known-hosts-0',
				'-oStrictHostKeyChecking=yes',
				'-oGlobalKnownHostsFile=/dev/null',
				'-oRemoteCommand=none',
				'--',
				'nix-daemon',
				'--stdio'
			],
			[
				'build@example.test',
				'-x',
				'-oUserKnownHostsFile=/tmp/cupboard-known-hosts-1',
				'-oStrictHostKeyChecking=yes',
				'-oGlobalKnownHostsFile=/dev/null',
				'-oRemoteCommand=none',
				'--',
				'nix-daemon',
				'--stdio'
			]
		]);

		await first.close();
		expect(
			disposeKnownHosts.map((dispose) => dispose.mock.calls)
		).toStrictEqual([[[]], []]);

		await second.close();
		expect(
			disposeKnownHosts.map((dispose) => dispose.mock.calls)
		).toStrictEqual([[[]], [[]]]);
	});

	it.each([
		{
			name: 'starts nix-daemon over SSH when remote-program is absent',
			spec: { destination: 'build@example.test' },
			expectedCommand: 'ssh',
			expectedArguments: [
				'build@example.test',
				'-x',
				'-oRemoteCommand=none',
				'--',
				'nix-daemon',
				'--stdio'
			]
		},
		{
			name: 'starts the configured remote program with its remote store',
			spec: {
				destination: 'example.test',
				remoteProgram: ['/opt/nix/bin/nix-daemon', '--option'],
				remoteStore: 'local?store=/remote/store'
			},
			expectedCommand: 'ssh',
			expectedArguments: [
				'example.test',
				'-x',
				'-oRemoteCommand=none',
				'--',
				'/opt/nix/bin/nix-daemon',
				'--option',
				'--stdio',
				'--store',
				'local?store=/remote/store'
			]
		},
		{
			name: 'starts --stdio as the command when remote-program is empty',
			spec: parseSshNgStoreUri('ssh-ng://example.test?remote-program='),
			expectedCommand: 'ssh',
			expectedArguments: [
				'example.test',
				'-x',
				'-oRemoteCommand=none',
				'--',
				'--stdio'
			]
		},
		{
			name: 'starts --stdio locally for an empty native-localhost program',
			spec: parseSshNgStoreUri('ssh-ng://localhost?remote-program=%20'),
			expectedCommand: '--stdio',
			expectedArguments: []
		},
		{
			name: 'starts nix-daemon locally for native localhost',
			spec: parseSshNgStoreUri('ssh-ng://localhost'),
			expectedCommand: 'nix-daemon',
			expectedArguments: ['--stdio']
		},
		{
			name: 'uses SSH when the localhost authority includes a user',
			spec: parseSshNgStoreUri('ssh-ng://build@localhost'),
			expectedCommand: 'ssh',
			expectedArguments: [
				'build@localhost',
				'-x',
				'-oRemoteCommand=none',
				'--',
				'nix-daemon',
				'--stdio'
			]
		},
		{
			name: 'uses the native-localhost path for an explicitly empty port',
			spec: parseSshNgStoreUri('ssh-ng://localhost:'),
			expectedCommand: 'nix-daemon',
			expectedArguments: ['--stdio']
		},
		{
			name: 'uses SSH for uppercase LOCALHOST',
			spec: parseSshNgStoreUri('ssh-ng://LOCALHOST'),
			expectedCommand: 'ssh',
			expectedArguments: [
				'LOCALHOST',
				'-x',
				'-oRemoteCommand=none',
				'--',
				'nix-daemon',
				'--stdio'
			]
		},
		{
			name: 'uses SSH when localhost has an explicit port',
			spec: parseSshNgStoreUri('ssh-ng://localhost:22'),
			expectedCommand: 'ssh',
			expectedArguments: [
				'localhost',
				'-x',
				'-p22',
				'-oRemoteCommand=none',
				'--',
				'nix-daemon',
				'--stdio'
			]
		}
	])('$name', async ({ spec, expectedCommand, expectedArguments }) => {
		if (spec === undefined) {
			throw new Error(
				'Expected parseSshNgStoreUri to accept the valid test URI'
			);
		}

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
			{ command: expectedCommand, commandArguments: expectedArguments }
		]);
	});

	it('caps active SSH daemon children at max-connections', async () => {
		const spec = parseSshNgStoreUri(
			'ssh-ng://build@example.test?max-connections=1'
		);

		if (spec?.maxConnections === undefined) {
			throw new Error(
				'Expected max-connections in the parsed SSH store settings'
			);
		}

		const firstStarted = Promise.withResolvers<undefined>();
		const releaseFirst = Promise.withResolvers<undefined>();
		let activeChildren = 0;
		let greatestActiveChildren = 0;
		let startedQueries = 0;
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(
				{ ...spec, sshPublicHostKey: 'ssh-ed25519 AAAA' },
				() => {
					activeChildren += 1;
					greatestActiveChildren = Math.max(
						greatestActiveChildren,
						activeChildren
					);

					return new FakeDaemonChild(
						new FakeDaemonTransport(
							{},
							{
								expectSetOptions: false,
								derivationOutputs: {
									[appDrvPath]: { out: appPath },
									[libraryDrvPath]: { out: libraryPath }
								},
								async beforeOperation() {
									startedQueries += 1;

									if (startedQueries === 1) {
										firstStarted.resolve(undefined);
										await releaseFirst.promise;
									}
								}
							}
						)
					);
				},
				{
					knownHostsFile: () => ({
						path: '/tmp/known-hosts',
						dispose: () => {
							activeChildren -= 1;
						}
					})
				}
			),
			maxConnections: spec.maxConnections,
			shouldPreserveDaemonOptions: true
		});

		const result = client.queryDerivationOutputPaths([
			appDrvPath,
			libraryDrvPath
		]);
		await firstStarted.promise;

		expect({ greatestActiveChildren, startedQueries }).toStrictEqual({
			greatestActiveChildren: 1,
			startedQueries: 1
		});

		releaseFirst.resolve(undefined);

		await expect(result).resolves.toStrictEqual([appPath, libraryPath]);
		expect({ activeChildren, greatestActiveChildren }).toStrictEqual({
			activeChildren: 0,
			greatestActiveChildren: 1
		});
	});

	it('closes a paused SSH NAR stream when its client is aborted', async () => {
		const controller = new AbortController();
		const disposeKnownHosts = vi.fn();
		const child = new FakeDaemonChild(
			new FakeDaemonTransport(
				{},
				{
					expectSetOptions: false,
					nar: {
						expectedPath: appPath,
						frames: [
							narFrame('nix-archive-1'),
							narFrame('(', 'type', 'regular', 'contents', 'nar contents', ')')
						]
					}
				}
			)
		);
		const client = new NixDaemonStoreClient({
			maxConnections: 1,
			signal: controller.signal,
			connect: createSshNixDaemonConnector(
				{
					destination: 'build@example.test',
					host: 'example.test',
					sshPublicHostKey: 'ssh-ed25519 AAAA'
				},
				() => child,
				{
					knownHostsFile: () => ({
						path: '/tmp/known-hosts',
						dispose: disposeKnownHosts
					})
				}
			),
			shouldPreserveDaemonOptions: true
		});
		const stream = client.narFromPath(appPath)[Symbol.asyncIterator]();

		await expect(stream.next()).resolves.toMatchObject({ done: false });

		try {
			controller.abort(new Error('cancel paused SSH NAR stream'));
			await new Promise<void>((resolve) => setImmediate(resolve));

			expect({
				kills: child.killed,
				disposals: disposeKnownHosts.mock.calls
			}).toStrictEqual({ kills: 1, disposals: [[]] });
		} finally {
			await stream.return?.();
		}
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
					env: {
						NIX_SSHOPTS:
							'-F "/run/ssh config" -o BatchMode=yes -oUserKnownHostsFile=/run/managed-known-hosts'
					},
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
					'-p2222',
					'-oCompression=yes',
					'-oRemoteCommand=none',
					'-F',
					'/run/ssh config',
					'-o',
					'BatchMode=yes',
					'-oUserKnownHostsFile=/run/managed-known-hosts',
					'-i',
					'/run/store key',
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

	it('makes URI host-key pins authoritative over inherited SSH options', async () => {
		const commands: string[][] = [];
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(
				{
					destination: 'build@example.test',
					host: 'example.test',
					sshPublicHostKey: 'ssh-ed25519 AAAA'
				},
				(_command, commandArguments) => {
					commands.push([...commandArguments]);

					return new FakeDaemonChild(new FakeDaemonTransport({}));
				},
				{
					env: {
						NIX_SSHOPTS:
							'-oStrictHostKeyChecking=no -o UserKnownHostsFile=/tmp/inherited -oGlobalKnownHostsFile=/tmp/global -o BatchMode=yes'
					},
					knownHostsFile: () => ({
						path: '/tmp/pinned-known-hosts',
						dispose: vi.fn()
					})
				}
			)
		});

		await expect(client.queryValidPaths([appPath])).resolves.toStrictEqual([]);
		expect(commands).toStrictEqual([
			[
				'build@example.test',
				'-x',
				'-oUserKnownHostsFile=/tmp/pinned-known-hosts',
				'-oStrictHostKeyChecking=yes',
				'-oGlobalKnownHostsFile=/dev/null',
				'-oRemoteCommand=none',
				'-oStrictHostKeyChecking=no',
				'-o',
				'UserKnownHostsFile=/tmp/inherited',
				'-oGlobalKnownHostsFile=/tmp/global',
				'-o',
				'BatchMode=yes',
				'--',
				'nix-daemon',
				'--stdio'
			]
		]);
	});

	it('disables inherited RemoteCommand before starting the daemon', async () => {
		const commands: string[][] = [];
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(
				{
					destination: 'build@example.test',
					remoteProgram: ['/opt/nix/bin/nix-daemon']
				},
				(_command, commandArguments) => {
					commands.push([...commandArguments]);

					return new FakeDaemonChild(new FakeDaemonTransport({}));
				},
				{ env: { NIX_SSHOPTS: '-oRemoteCommand=/tmp/inherited' } }
			)
		});

		await expect(client.queryValidPaths([appPath])).resolves.toStrictEqual([]);
		expect(commands).toStrictEqual([
			[
				'build@example.test',
				'-x',
				'-oRemoteCommand=none',
				'-oRemoteCommand=/tmp/inherited',
				'--',
				'/opt/nix/bin/nix-daemon',
				'--stdio'
			]
		]);
	});

	it.each([
		{
			name: 'uses the URI port before an inherited -p option',
			sshOptions: '-p 10022 -o BatchMode=yes',
			inheritedArguments: ['-p', '10022', '-o', 'BatchMode=yes']
		},
		{
			name: 'uses the URI port before an inherited Port setting and SSH config',
			sshOptions: '-oPort=10023 -F "/run/ssh config"',
			inheritedArguments: ['-oPort=10023', '-F', '/run/ssh config']
		}
	])('$name', async (fixture) => {
		const commands: string[][] = [];
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(
				{
					destination: 'build@example.test',
					port: 2222
				},
				(_command, commandArguments) => {
					commands.push([...commandArguments]);

					return new FakeDaemonChild(new FakeDaemonTransport({}));
				},
				{ env: { NIX_SSHOPTS: fixture.sshOptions } }
			)
		});

		await expect(client.queryValidPaths([appPath])).resolves.toStrictEqual([]);
		expect(commands).toStrictEqual([
			[
				'build@example.test',
				'-x',
				'-p2222',
				'-oRemoteCommand=none',
				...fixture.inheritedArguments,
				'--',
				'nix-daemon',
				'--stdio'
			]
		]);
	});

	it.each([
		{
			name: 'enables compression and removes an inherited short flag',
			compress: true,
			expectedCompressionArguments: ['-oCompression=yes'],
			inheritedOptions: '-C -oCompression=no',
			expectedInheritedArguments: ['-oCompression=no']
		},
		{
			name: 'disables compression and removes an inherited short flag',
			compress: false,
			expectedCompressionArguments: ['-oCompression=no'],
			inheritedOptions: '-C -oCompression=yes',
			expectedInheritedArguments: ['-oCompression=yes']
		},
		{
			name: 'removes compression from inherited short-option clusters',
			compress: false,
			expectedCompressionArguments: ['-oCompression=no'],
			inheritedOptions: '-vC -Cv',
			expectedInheritedArguments: ['-v', '-v']
		},
		{
			name: 'removes compression around inherited configuration options',
			compress: false,
			expectedCompressionArguments: ['-oCompression=no'],
			inheritedOptions:
				'-F "/run/ssh config" -C -o BatchMode=yes -C -F/run/other-config',
			expectedInheritedArguments: [
				'-F',
				'/run/ssh config',
				'-o',
				'BatchMode=yes',
				'-F/run/other-config'
			]
		},
		{
			name: 'preserves short flags used as configuration option arguments',
			compress: false,
			expectedCompressionArguments: ['-oCompression=no'],
			inheritedOptions: '-F -C -o -C -C',
			expectedInheritedArguments: ['-F', '-C', '-o', '-C']
		},
		{
			name: 'preserves inherited compression when the URI does not set it',
			compress: undefined,
			expectedCompressionArguments: [],
			inheritedOptions: '-C',
			expectedInheritedArguments: ['-C']
		}
	])('$name', async (fixture) => {
		const commands: string[][] = [];
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(
				{
					destination: 'build@example.test',
					...(fixture.compress !== undefined && {
						compress: fixture.compress
					})
				},
				(_command, commandArguments) => {
					commands.push([...commandArguments]);

					return new FakeDaemonChild(new FakeDaemonTransport({}));
				},
				{ env: { NIX_SSHOPTS: fixture.inheritedOptions } }
			)
		});

		await expect(client.queryValidPaths([appPath])).resolves.toStrictEqual([]);
		expect(commands).toStrictEqual([
			[
				'build@example.test',
				'-x',
				...fixture.expectedCompressionArguments,
				'-oRemoteCommand=none',
				...fixture.expectedInheritedArguments,
				'--',
				'nix-daemon',
				'--stdio'
			]
		]);
	});

	it.each([
		{
			name: 'formats the default port as a bare host in known_hosts',
			destination: 'build@example.test',
			host: 'example.test',
			port: 22,
			expected: 'example.test'
		},
		{
			name: 'formats a nonstandard IPv6 port with brackets in known_hosts',
			destination: 'build@2001:db8::1',
			host: '2001:db8::1',
			port: 2222,
			expected: '[2001:db8::1]:2222'
		}
	])('$name', async (fixture) => {
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
				'-oRemoteCommand=none',
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

	it('reports an unfinished quote in NIX_SSHOPTS', async () => {
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(
				{ destination: 'example.test' },
				() => new FakeDaemonChild(new FakeDaemonTransport({})),
				{ env: { NIX_SSHOPTS: '"unfinished' } }
			)
		});

		await expect(client.queryValidPaths([appPath])).rejects.toThrow(
			'Could not parse NIX_SSHOPTS: a quoted value has no closing quote'
		);
	});

	it('removes a generated host-key file when ssh cannot start', async () => {
		const disposeKnownHosts = vi.fn();
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
					knownHostsFile: () => ({
						path: '/tmp/known-hosts',
						dispose: disposeKnownHosts
					})
				}
			)
		});

		await expect(client.queryValidPaths([appPath])).rejects.toBe(failure);
		expect(disposeKnownHosts.mock.calls).toStrictEqual([[]]);
	});

	it('cancels a stalled pooled SSH handshake before rejecting a failed closure query', async () => {
		const failure = new Error('path query failed');
		let operations = 0;
		const first = new FakeDaemonChild(
			new FakeDaemonTransport(
				{
					[appPath]: {
						hash: '11'.repeat(32),
						narSize: 1,
						references: [libraryPath, runtimePath],
						signatures: []
					}
				},
				{
					beforeOperation: () => {
						operations += 1;

						return operations === 1
							? Promise.resolve()
							: Promise.reject(failure);
					}
				}
			)
		);
		const stalled = new StalledHandshakeChild();
		const children = [first, stalled];
		const disposeKnownHosts = [vi.fn(), vi.fn()];
		let childIndex = 0;
		let knownHostsIndex = 0;
		const client = new NixDaemonStoreClient({
			connect: createSshNixDaemonConnector(
				{
					destination: 'build@example.test',
					host: 'example.test',
					sshPublicHostKey: 'ssh-ed25519 AAAA'
				},
				() => children[childIndex++] ?? new StalledHandshakeChild(),
				{
					knownHostsFile: () => ({
						path: `/tmp/known-hosts-${String(knownHostsIndex)}`,
						dispose: disposeKnownHosts[knownHostsIndex++] ?? vi.fn()
					})
				}
			)
		});

		await expect(client.resolveClosure([appPath])).rejects.toBe(failure);
		expect({
			kills: [first.killed, stalled.killed],
			disposals: disposeKnownHosts.map((dispose) => dispose.mock.calls)
		}).toStrictEqual({
			kills: [1, 1],
			disposals: [[[]], [[]]]
		});
	});
});

function narFrame(...values: readonly string[]): Buffer {
	const writer = new ProtocolWriter();

	for (const value of values) {
		writer.writeString(value);
	}

	return writer.bytes();
}
