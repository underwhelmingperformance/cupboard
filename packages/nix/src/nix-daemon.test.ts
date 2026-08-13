import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	type FakeBuildResult,
	FakeDaemonReadUnderflowError,
	FakeDaemonTransport,
	readRequestStorePath
} from '../../../tests/support/fake-daemon-transport.ts';
import { ProtocolWriter } from '../../../tests/support/protocol-writer.ts';

import {
	connectToNixDaemon,
	InvalidNixDaemonNarError,
	NixDaemonStoreClient,
	UnsupportedNixDaemonProtocolError
} from './nix-daemon.ts';
import {
	InvalidNixStorePathError,
	type NixBuildResult,
	type NixDerivedPathString,
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from './nix-store.ts';

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const libraryPath = storePathSchema.parse(
	'/nix/store/2123456789abcdfghijklmnpqrsvwxyz-lib'
);
const runtimePath = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime'
);
const appHash = '11'.repeat(32);
const libraryHash = '22'.repeat(32);
const runtimeHash = '33'.repeat(32);
const buildDrvPath = storePathSchema.parse(
	'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv'
);

interface BuildResultCase {
	readonly name: string;
	readonly targets: readonly NixDerivedPathString[];
	readonly expectedTargets: readonly string[];
	readonly result: FakeBuildResult;
	readonly expected: NixBuildResult;
}

const buildResultCases: readonly BuildResultCase[] = [
	{
		name: 'a built derivation with several outputs',
		targets: [`${buildDrvPath}^*`],
		expectedTargets: [`${buildDrvPath}!*`],
		result: {
			target: `${buildDrvPath}!*`,
			status: 0,
			errorMessage: '',
			timesBuilt: 1,
			nonDeterministic: false,
			startTime: 100,
			stopTime: 260,
			cpuUserMicroseconds: 1500,
			cpuSystemMicroseconds: 300,
			builtOutputs: [
				{
					id: `sha256:${'aa'.repeat(32)}!out`,
					realisation: JSON.stringify({ outPath: appPath })
				},
				{
					id: `sha256:${'aa'.repeat(32)}!dev`,
					realisation: JSON.stringify({ outPath: libraryPath })
				}
			]
		},
		expected: {
			target: `${buildDrvPath}^*`,
			outcome: {
				kind: 'built',
				outputs: { out: appPath, dev: libraryPath }
			},
			timesBuilt: 1,
			nonDeterministic: false,
			startTime: 100,
			stopTime: 260
		}
	},
	{
		name: 'a substituted path',
		targets: [appPath],
		expectedTargets: [appPath],
		result: {
			target: appPath,
			status: 1,
			errorMessage: '',
			timesBuilt: 0,
			nonDeterministic: false,
			startTime: 0,
			stopTime: 0,
			builtOutputs: []
		},
		expected: {
			target: appPath,
			outcome: { kind: 'substituted', outputs: {} },
			timesBuilt: 0,
			nonDeterministic: false,
			startTime: 0,
			stopTime: 0
		}
	},
	{
		name: 'an already valid path',
		targets: [appPath],
		expectedTargets: [appPath],
		result: {
			target: appPath,
			status: 2,
			errorMessage: '',
			timesBuilt: 0,
			nonDeterministic: false,
			startTime: 0,
			stopTime: 0,
			builtOutputs: []
		},
		expected: {
			target: appPath,
			outcome: { kind: 'already-valid', outputs: {} },
			timesBuilt: 0,
			nonDeterministic: false,
			startTime: 0,
			stopTime: 0
		}
	},
	{
		name: 'a permanent failure',
		targets: [`${buildDrvPath}^out`],
		expectedTargets: [`${buildDrvPath}!out`],
		result: {
			target: `${buildDrvPath}!out`,
			status: 3,
			errorMessage: 'builder failed with exit code 1',
			timesBuilt: 1,
			nonDeterministic: false,
			startTime: 10,
			stopTime: 20,
			builtOutputs: []
		},
		expected: {
			target: `${buildDrvPath}^out`,
			outcome: {
				kind: 'permanent-failure',
				message: 'builder failed with exit code 1'
			},
			timesBuilt: 1,
			nonDeterministic: false,
			startTime: 10,
			stopTime: 20
		}
	},
	{
		name: 'a path no substituter can place',
		targets: [appPath],
		expectedTargets: [appPath],
		result: {
			target: appPath,
			status: 14,
			errorMessage: 'no substituters can build this path',
			timesBuilt: 0,
			nonDeterministic: false,
			startTime: 0,
			stopTime: 0,
			builtOutputs: []
		},
		expected: {
			target: appPath,
			outcome: {
				kind: 'no-substituters',
				message: 'no substituters can build this path'
			},
			timesBuilt: 0,
			nonDeterministic: false,
			startTime: 0,
			stopTime: 0
		}
	},
	{
		name: 'a resolution to an already valid output',
		targets: [`${buildDrvPath}^out`],
		expectedTargets: [`${buildDrvPath}!out`],
		result: {
			target: `${buildDrvPath}!out`,
			status: 13,
			errorMessage: '',
			timesBuilt: 0,
			nonDeterministic: false,
			startTime: 0,
			stopTime: 0,
			builtOutputs: [
				{
					id: `sha256:${'bb'.repeat(32)}!out`,
					realisation: JSON.stringify({ outPath: appPath })
				}
			]
		},
		expected: {
			target: `${buildDrvPath}^out`,
			outcome: {
				kind: 'resolves-to-already-valid',
				outputs: { out: appPath }
			},
			timesBuilt: 0,
			nonDeterministic: false,
			startTime: 0,
			stopTime: 0
		}
	}
];

describe('connectToNixDaemon', () => {
	// The fakes elsewhere bypass the socket transport entirely, so this is the
	// one place its write/read path meets a real socket (where Node calls the
	// write callback with null, not undefined, on success).
	it('writes and reads through a real unix socket', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'cupboard-nix-'));
		const socketPath = path.join(directory, 'socket');
		const server = createServer((connection) => {
			connection.pipe(connection);
		});

		await new Promise<void>((resolve) => {
			server.listen(socketPath, resolve);
		});

		try {
			const transport = await connectToNixDaemon(socketPath);

			await transport.write(new Uint8Array([1, 2, 3, 4]));
			const echoed = await transport.read(4);
			await transport.close();

			expect([...echoed]).toStrictEqual([1, 2, 3, 4]);
		} finally {
			server.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe('NixDaemonStoreClient', () => {
	it('reads path info through the Nix daemon protocol', async () => {
		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			connect: () => {
				transport = new FakeDaemonTransport({
					[appPath]: {
						hash: appHash,
						narSize: 123,
						references: [libraryPath, runtimePath],
						deriver: '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv',
						ca: 'fixed:r:sha256:hash',
						signatures: ['cache:first', 'cache:second'],
						ultimate: true
					}
				});

				return Promise.resolve(transport);
			}
		});

		await expect(client.queryPathInfo(appPath)).resolves.toStrictEqual({
			storePath: appPath,
			narHash: NixSha256Hash.fromDigest(Buffer.from(appHash, 'hex')),
			narSize: 123,
			references: [libraryPath, runtimePath],
			deriver: '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv',
			ca: 'fixed:r:sha256:hash',
			signatures: ['cache:first', 'cache:second'],
			ultimate: true
		});
		expect(transport?.closed).toBe(true);
	});

	it('writes configured dedicated SetOptions fields', async () => {
		const client = new NixDaemonStoreClient({
			setOptions: {
				keepFailed: true,
				keepGoing: true,
				tryFallback: true,
				maxBuildJobs: 8,
				maxSilentTime: 30,
				buildCores: 4,
				useSubstitutes: false
			},
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport(
						{
							[appPath]: {
								hash: appHash,
								narSize: 123,
								references: [],
								signatures: []
							}
						},
						{
							expectedSetOptions: {
								keepFailed: true,
								keepGoing: true,
								tryFallback: true,
								maxBuildJobs: 8,
								maxSilentTime: 30,
								buildCores: 4,
								useSubstitutes: false
							}
						}
					)
				)
		});

		await expect(client.queryPathInfo(appPath)).resolves.toStrictEqual(
			pathInfo(appPath, appHash, 123, [])
		);
	});

	it('writes the default SetOptions fields when nothing is configured', async () => {
		const client = new NixDaemonStoreClient({
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport(
						{
							[appPath]: {
								hash: appHash,
								narSize: 123,
								references: [],
								signatures: []
							}
						},
						{
							expectedSetOptions: {
								keepFailed: false,
								keepGoing: false,
								tryFallback: false,
								maxBuildJobs: 1,
								maxSilentTime: 0,
								buildCores: 0,
								useSubstitutes: true
							}
						}
					)
				)
		});

		await expect(client.queryPathInfo(appPath)).resolves.toStrictEqual(
			pathInfo(appPath, appHash, 123, [])
		);
	});

	it('forwards the sorted overrides map on every connection', async () => {
		const overrides = {
			substituters: 'https://cache.nixos.org https://cupboard.example/cache',
			'trusted-public-keys': 'cache.nixos.org-1:key cupboard-1:key',
			'sandbox-paths': '/build /work',
			'netrc-file': '/tmp/cupboard-netrc'
		};
		const paths = {
			[appPath]: {
				hash: appHash,
				narSize: 123,
				references: [],
				signatures: []
			},
			[libraryPath]: {
				hash: libraryHash,
				narSize: 456,
				references: [],
				signatures: []
			}
		};
		let connections = 0;
		const client = new NixDaemonStoreClient({
			overrides,
			connect: () => {
				connections += 1;

				return Promise.resolve(
					new FakeDaemonTransport(paths, { expectedOverrides: overrides })
				);
			}
		});

		await expect(client.queryPathInfo(appPath)).resolves.toStrictEqual(
			pathInfo(appPath, appHash, 123, [])
		);
		await expect(client.queryPathInfo(libraryPath)).resolves.toStrictEqual(
			pathInfo(libraryPath, libraryHash, 456, [])
		);
		expect(connections).toBe(2);
	});

	it('queries valid paths in one daemon operation', async () => {
		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			connect: () => {
				transport = new FakeDaemonTransport({
					[appPath]: {
						hash: appHash,
						narSize: 123,
						references: [],
						signatures: []
					}
				});

				return Promise.resolve(transport);
			}
		});

		await expect(
			client.queryValidPaths([libraryPath, appPath, appPath])
		).resolves.toStrictEqual([appPath]);
		expect(transport?.closed).toBe(true);
	});

	it('asks the configured substituters for paths in one daemon operation', async () => {
		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			connect: () => {
				transport = new FakeDaemonTransport(
					{},
					{
						substitutable: {
							expectedPaths: [appPath, libraryPath, runtimePath],
							paths: [runtimePath, appPath]
						}
					}
				);

				return Promise.resolve(transport);
			}
		});

		await expect(
			client.querySubstitutablePaths([
				runtimePath,
				appPath,
				libraryPath,
				appPath
			])
		).resolves.toStrictEqual([appPath, runtimePath]);
		expect(transport?.closed).toBe(true);
	});

	it('reports what the substituters offer, omitting a path none of them serves', async () => {
		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			connect: () => {
				transport = new FakeDaemonTransport(
					{},
					{
						substitutablePathInfos: {
							[appPath]: {
								storePath: appPath,
								deriver: buildDrvPath,
								references: [libraryPath],
								downloadSize: 512,
								narSize: 2048
							},
							[runtimePath]: {
								storePath: runtimePath,
								references: [],
								downloadSize: 0,
								narSize: 64
							}
						}
					}
				);

				return Promise.resolve(transport);
			}
		});

		await expect(
			client.querySubstitutablePathInfos([
				runtimePath,
				appPath,
				libraryPath,
				appPath
			])
		).resolves.toStrictEqual([
			{
				storePath: appPath,
				deriver: buildDrvPath,
				references: [libraryPath],
				downloadSize: 512,
				narSize: 2048
			},
			{
				storePath: runtimePath,
				references: [],
				downloadSize: 0,
				narSize: 64
			}
		]);
		expect({
			requests: transport?.substitutablePathInfoRequests,
			closed: transport?.closed
		}).toStrictEqual({
			requests: [[appPath, libraryPath, runtimePath]],
			closed: true
		});
	});

	it('answers an empty substitutable-info batch without opening a connection', async () => {
		const client = new NixDaemonStoreClient({
			connect: () => {
				throw new Error('the empty batch must not open a connection');
			}
		});

		await expect(client.querySubstitutablePathInfos([])).resolves.toStrictEqual(
			[]
		);
	});

	it('uses the negotiated path-info batch operation', async () => {
		const missingPath = storePathSchema.parse(
			'/nix/store/9123456789abcdfghijklmnpqrsvwxyz-missing'
		);
		const paths = {
			[appPath]: {
				hash: appHash,
				narSize: 123,
				references: [libraryPath],
				signatures: []
			},
			[libraryPath]: {
				hash: libraryHash,
				narSize: 456,
				references: [],
				signatures: []
			}
		};
		let connections = 0;
		const client = new NixDaemonStoreClient({
			connect: () => {
				connections += 1;

				return Promise.resolve(
					new FakeDaemonTransport(paths, {
						features: ['queryPathInfos'],
						expectedPathInfoBatch: [appPath, libraryPath, missingPath]
					})
				);
			}
		});

		await expect(
			client.queryValidPathsInfo([libraryPath, missingPath, appPath])
		).resolves.toStrictEqual([
			pathInfo(libraryPath, libraryHash, 456, []),
			pathInfo(appPath, appHash, 123, [libraryPath])
		]);
		expect(connections).toBe(1);
	});

	it('rejects a batched query missing a path with a typed path error', async () => {
		const missingPath = storePathSchema.parse(
			'/nix/store/9123456789abcdfghijklmnpqrsvwxyz-missing'
		);
		const client = new NixDaemonStoreClient({
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport(
						{
							[appPath]: {
								hash: appHash,
								narSize: 123,
								references: [],
								signatures: []
							}
						},
						{ features: ['queryPathInfos'] }
					)
				)
		});

		let outcome:
			| { value: readonly NixValidPathInfo[] }
			| { error: { name: string; storePath: string } };
		try {
			const value = await client.queryPathsInfo([appPath, missingPath]);
			outcome = { value };
		} catch (error_: unknown) {
			expect(error_).toBeInstanceOf(NixStorePathNotFoundError);

			if (!(error_ instanceof NixStorePathNotFoundError)) {
				throw error_;
			}

			outcome = {
				error: { name: error_.name, storePath: error_.storePath }
			};
		}

		expect(outcome).toStrictEqual({
			error: {
				name: 'NixStorePathNotFoundError',
				storePath: missingPath
			}
		});
	});

	it('falls back to pooled per-path queries in argument order', async () => {
		const paths = {
			[appPath]: {
				hash: appHash,
				narSize: 123,
				references: [libraryPath],
				signatures: []
			},
			[libraryPath]: {
				hash: libraryHash,
				narSize: 456,
				references: [],
				signatures: []
			}
		};
		const transports: FakeDaemonTransport[] = [];
		const client = new NixDaemonStoreClient({
			connect: () => {
				const transport = new FakeDaemonTransport(paths);
				transports.push(transport);

				return Promise.resolve(transport);
			}
		});

		await expect(
			client.queryPathsInfo([libraryPath, appPath])
		).resolves.toStrictEqual([
			pathInfo(libraryPath, libraryHash, 456, []),
			pathInfo(appPath, appHash, 123, [libraryPath])
		]);
		expect(transports.map((transport) => transport.closed)).toStrictEqual([
			true,
			true
		]);
	});

	it('reuses the probing connection as the fallback pool connection', async () => {
		let connections = 0;
		const client = new NixDaemonStoreClient({
			connect: () => {
				connections += 1;

				return Promise.resolve(
					new FakeDaemonTransport({
						[appPath]: {
							hash: appHash,
							narSize: 123,
							references: [],
							signatures: []
						}
					})
				);
			}
		});

		await expect(client.queryPathsInfo([appPath])).resolves.toStrictEqual([
			pathInfo(appPath, appHash, 123, [])
		]);
		expect(connections).toBe(1);
	});

	it('filters unregistered paths from a pooled valid-path-info query', async () => {
		const missingPath = storePathSchema.parse(
			'/nix/store/9123456789abcdfghijklmnpqrsvwxyz-missing'
		);
		const client = new NixDaemonStoreClient({
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport({
						[appPath]: {
							hash: appHash,
							narSize: 123,
							references: [],
							signatures: []
						}
					})
				)
		});

		await expect(
			client.queryValidPathsInfo([missingPath, appPath])
		).resolves.toStrictEqual([pathInfo(appPath, appHash, 123, [])]);
	});

	it.each(buildResultCases)(
		'decodes the build result for $name',
		async ({ targets, expectedTargets, result, expected }) => {
			let transport: FakeDaemonTransport | undefined;
			const client = new NixDaemonStoreClient({
				connect: () => {
					transport = new FakeDaemonTransport(
						{},
						{ builds: { expectedTargets, results: [result] } }
					);

					return Promise.resolve(transport);
				}
			});

			await expect(
				client.buildPathsWithResults(targets)
			).resolves.toStrictEqual([expected]);
			expect(transport?.closed).toBe(true);
		}
	);

	it('answers an empty build request without opening a connection', async () => {
		let connections = 0;
		const client = new NixDaemonStoreClient({
			connect: () => {
				connections += 1;

				return Promise.resolve(new FakeDaemonTransport({}));
			}
		});

		await expect(client.buildPathsWithResults([])).resolves.toStrictEqual([]);
		expect(connections).toBe(0);
	});

	it('streams a NAR reassembled across daemon frames in order', async () => {
		const bigContent = 'x'.repeat(150_000);
		const contentFrame = narFrame(bigContent);
		const frames = [
			narFrame('nix-archive-1'),
			narFrame('(', 'type', 'directory'),
			narFrame('entry', '(', 'name', 'app', 'node'),
			narFrame('(', 'type', 'regular', 'executable', '', 'contents'),
			// The content token split mid-frame proves reassembly does not
			// depend on how the daemon's writes were chunked.
			contentFrame.subarray(0, 1000),
			contentFrame.subarray(1000),
			narFrame(')', ')'),
			narFrame('entry', '(', 'name', 'lib', 'node'),
			narFrame('(', 'type', 'symlink', 'target', './app', ')', ')'),
			narFrame(')')
		];
		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			connect: () => {
				transport = new FakeDaemonTransport(
					{},
					{ nar: { expectedPath: appPath, frames } }
				);

				return Promise.resolve(transport);
			}
		});

		const chunks = await Array.fromAsync(client.narFromPath(appPath));

		expect(Buffer.concat(chunks)).toStrictEqual(Buffer.concat(frames));
		expect(transport?.closed).toBe(true);
	});

	it('reads a derivation out of the single regular file its NAR holds', async () => {
		const aterm = 'Derive([],[],[],"aarch64-linux","builder",[],[])';
		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			connect: () => {
				transport = new FakeDaemonTransport(
					{},
					{
						nar: {
							expectedPath: appPath,
							frames: [
								narFrame(
									'nix-archive-1',
									'(',
									'type',
									'regular',
									'contents',
									aterm,
									')'
								)
							]
						}
					}
				);

				return Promise.resolve(transport);
			}
		});

		const contents = await client.readDerivation(appPath);

		expect({ contents, closed: transport?.closed }).toStrictEqual({
			contents: aterm,
			closed: true
		});
	});

	it('surfaces a typed error for bytes that do not form a NAR', async () => {
		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			connect: () => {
				transport = new FakeDaemonTransport(
					{},
					{
						nar: {
							expectedPath: appPath,
							frames: [narFrame('nix-archive-1', '(', 'type', 'weird')]
						}
					}
				);

				return Promise.resolve(transport);
			}
		});

		let outcome: { drained: true } | { error: { name: string } };
		try {
			for await (const chunk of client.narFromPath(appPath)) {
				void chunk;
			}
			outcome = { drained: true };
		} catch (error_: unknown) {
			expect(error_).toBeInstanceOf(InvalidNixDaemonNarError);

			if (!(error_ instanceof InvalidNixDaemonNarError)) {
				throw error_;
			}

			outcome = { error: { name: error_.name } };
		}

		expect(outcome).toStrictEqual({
			error: { name: 'InvalidNixDaemonNarError' }
		});
		expect(transport?.closed).toBe(true);
	});

	it('closes the streaming connection when the stream fails mid-way', async () => {
		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			connect: () => {
				transport = new FakeDaemonTransport(
					{},
					{
						nar: {
							expectedPath: appPath,
							// The archive stops mid-node, so a read runs out of
							// bytes part-way through the copy.
							frames: [narFrame('nix-archive-1', '(', 'type', 'regular')]
						}
					}
				);

				return Promise.resolve(transport);
			}
		});

		const drain = async (): Promise<void> => {
			for await (const chunk of client.narFromPath(appPath)) {
				void chunk;
			}
		};

		await expect(drain()).rejects.toBeInstanceOf(FakeDaemonReadUnderflowError);
		expect(transport?.closed).toBe(true);
	});

	it('closes the streaming connection when the consumer stops early', async () => {
		const frames = [
			narFrame('nix-archive-1'),
			narFrame('(', 'type', 'regular', 'contents', 'y'.repeat(100_000), ')')
		];
		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			connect: () => {
				transport = new FakeDaemonTransport(
					{},
					{ nar: { expectedPath: appPath, frames } }
				);

				return Promise.resolve(transport);
			}
		});

		for await (const chunk of client.narFromPath(appPath)) {
			void chunk;
			break;
		}

		expect(transport?.closed).toBe(true);
	});

	it('holds temporary roots and queries on one session connection', async () => {
		const transports: FakeDaemonTransport[] = [];
		const client = new NixDaemonStoreClient({
			connect: () => {
				const transport = new FakeDaemonTransport({
					[appPath]: {
						hash: appHash,
						narSize: 123,
						references: [],
						signatures: []
					}
				});
				transports.push(transport);

				return Promise.resolve(transport);
			}
		});

		const outcome = await client.withConnection(async (session) => {
			await session.addTempRoot(appPath);
			await session.addTempRoot(libraryPath);

			return {
				valid: await session.queryValidPaths([libraryPath, appPath]),
				info: await session.queryPathInfo(appPath)
			};
		});

		expect(outcome).toStrictEqual({
			valid: [appPath],
			info: pathInfo(appPath, appHash, 123, [])
		});
		expect(
			transports.map((transport) => ({
				closed: transport.closed,
				temporaryRoots: transport.temporaryRoots
			}))
		).toStrictEqual([{ closed: true, temporaryRoots: [appPath, libraryPath] }]);
	});

	it.each([
		{ name: 'resolves', shouldFail: false },
		{ name: 'rejects', shouldFail: true }
	])(
		'closes the session connection when the callback $name',
		async ({ shouldFail }) => {
			let transport: FakeDaemonTransport | undefined;
			let openDuringCallback: boolean | undefined;
			const client = new NixDaemonStoreClient({
				connect: () => {
					transport = new FakeDaemonTransport({
						[appPath]: {
							hash: appHash,
							narSize: 123,
							references: [],
							signatures: []
						}
					});

					return Promise.resolve(transport);
				}
			});

			const run = client.withConnection(async (session) => {
				await session.addTempRoot(appPath);
				openDuringCallback = transport?.closed === false;

				if (shouldFail) {
					throw new SessionAbortedError();
				}

				return session.queryPathInfo(appPath);
			});

			await (shouldFail
				? expect(run).rejects.toBeInstanceOf(SessionAbortedError)
				: expect(run).resolves.toStrictEqual(
						pathInfo(appPath, appHash, 123, [])
					));

			expect({ openDuringCallback, closed: transport?.closed }).toStrictEqual({
				openDuringCallback: true,
				closed: true
			});
		}
	);

	it('partitions realisation work through one QueryMissing operation', async () => {
		const appDrvPath = storePathSchema.parse(
			'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv'
		);
		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			connect: () => {
				transport = new FakeDaemonTransport(
					{},
					{
						missing: {
							expectedTargets: [libraryPath, `${appDrvPath}!out`],
							willBuild: [appPath],
							willSubstitute: [runtimePath, libraryPath],
							unknown: [],
							downloadSize: 4096,
							narSize: 16_384
						}
					}
				);

				return Promise.resolve(transport);
			}
		});

		await expect(
			client.queryMissing([libraryPath, `${appDrvPath}^out`, libraryPath])
		).resolves.toStrictEqual({
			willBuild: [appPath],
			willSubstitute: [libraryPath, runtimePath],
			unknown: [],
			downloadSize: 4096,
			narSize: 16_384
		});
		expect(transport?.closed).toBe(true);
	});

	it('answers an empty QueryMissing without opening a connection', async () => {
		let connections = 0;
		const client = new NixDaemonStoreClient({
			connect: () => {
				connections += 1;

				return Promise.resolve(new FakeDaemonTransport({}));
			}
		});

		await expect(client.queryMissing([])).resolves.toStrictEqual({
			willBuild: [],
			willSubstitute: [],
			unknown: [],
			downloadSize: 0,
			narSize: 0
		});
		expect(connections).toBe(0);
	});

	it('reads realised derivation outputs through pooled daemon connections', async () => {
		const appDrvPath = storePathSchema.parse(
			'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv'
		);
		const libraryDrvPath = storePathSchema.parse(
			'/nix/store/5123456789abcdfghijklmnpqrsvwxyz-lib.drv'
		);
		const transports: FakeDaemonTransport[] = [];
		const client = new NixDaemonStoreClient({
			connect: () => {
				const transport = new FakeDaemonTransport(
					{},
					{
						derivationOutputs: {
							[appDrvPath]: { out: appPath, dev: undefined },
							[libraryDrvPath]: { out: libraryPath }
						}
					}
				);
				transports.push(transport);

				return Promise.resolve(transport);
			}
		});

		await expect(
			client.queryDerivationOutputPaths([
				libraryDrvPath,
				appDrvPath,
				libraryDrvPath
			])
		).resolves.toStrictEqual([appPath, libraryPath]);
		expect(transports.map((transport) => transport.closed)).toStrictEqual([
			true,
			true
		]);
	});

	it('bounds concurrent derivation output queries to the daemon pool size', async () => {
		const drvPaths = Array.from({ length: 17 }, (_, index) =>
			storePathSchema.parse(
				`/nix/store/${String(index).padStart(32, '0')}-output-${String(index)}.drv`
			)
		);
		const firstFrontierStarted = Promise.withResolvers<undefined>();
		const queuedQueryStarted = Promise.withResolvers<undefined>();
		const releases = new Map<string, () => void>();
		const started = new Set<string>();
		let connections = 0;
		const client = new NixDaemonStoreClient({
			connect: () => {
				connections += 1;

				return Promise.resolve(
					new FakeDaemonTransport(
						{},
						{
							derivationOutputs: {},
							beforeOperation(request) {
								const drvPath = readRequestStorePath(request);
								started.add(drvPath);

								if (started.size === 16) {
									firstFrontierStarted.resolve(undefined);
								} else if (started.size === 17) {
									queuedQueryStarted.resolve(undefined);
								}

								return new Promise<undefined>((resolve) => {
									releases.set(drvPath, () => {
										resolve(undefined);
									});
								});
							}
						}
					)
				);
			}
		});

		const result = client.queryDerivationOutputPaths(drvPaths);
		await firstFrontierStarted.promise;

		expect({ connections, started: started.size }).toStrictEqual({
			connections: 16,
			started: 16
		});

		const firstDrvPath = drvPaths[0];

		if (firstDrvPath === undefined) {
			throw new Error('Expected at least one derivation path');
		}

		releases.get(firstDrvPath)?.();
		await queuedQueryStarted.promise;

		for (const release of releases.values()) {
			release();
		}

		await expect(result).resolves.toStrictEqual([]);
		expect({ connections, started: started.size }).toStrictEqual({
			connections: 16,
			started: 17
		});
	});

	it('resolves closure by walking daemon path references', async () => {
		const client = new NixDaemonStoreClient({
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport({
						[appPath]: {
							hash: appHash,
							narSize: 123,
							references: [libraryPath, runtimePath],
							signatures: []
						},
						[libraryPath]: {
							hash: libraryHash,
							narSize: 456,
							references: [runtimePath],
							signatures: []
						},
						[runtimePath]: {
							hash: runtimeHash,
							narSize: 789,
							references: [],
							signatures: []
						}
					})
				)
		});

		await expect(client.resolveClosure([appPath])).resolves.toStrictEqual([
			pathInfo(appPath, appHash, 123, [libraryPath, runtimePath]),
			pathInfo(libraryPath, libraryHash, 456, [runtimePath]),
			pathInfo(runtimePath, runtimeHash, 789, [])
		]);
	});

	it('resolves a multi-path frontier across several connections', async () => {
		const transports: FakeDaemonTransport[] = [];
		const client = new NixDaemonStoreClient({
			connect: () => {
				const transport = new FakeDaemonTransport({
					[appPath]: {
						hash: appHash,
						narSize: 123,
						references: [libraryPath, runtimePath],
						signatures: []
					},
					[libraryPath]: {
						hash: libraryHash,
						narSize: 456,
						references: [],
						signatures: []
					},
					[runtimePath]: {
						hash: runtimeHash,
						narSize: 789,
						references: [],
						signatures: []
					}
				});
				transports.push(transport);

				return Promise.resolve(transport);
			}
		});

		await expect(client.resolveClosure([appPath])).resolves.toStrictEqual([
			pathInfo(appPath, appHash, 123, [libraryPath, runtimePath]),
			pathInfo(libraryPath, libraryHash, 456, []),
			pathInfo(runtimePath, runtimeHash, 789, [])
		]);

		// The root is one frontier on its own; its two references form the next,
		// so the pool opens a second connection to query them at the same time.
		expect(transports.map((transport) => transport.closed)).toStrictEqual([
			true,
			true
		]);
	});

	it('rejects daemon misses with a typed path error', async () => {
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(new FakeDaemonTransport({}))
		});

		let outcome:
			| { value: Awaited<ReturnType<typeof client.queryPathInfo>> }
			| { error: { name: string; storePath: string } };
		try {
			const value = await client.queryPathInfo(appPath);
			outcome = { value };
		} catch (error_: unknown) {
			expect(error_).toBeInstanceOf(NixStorePathNotFoundError);

			if (!(error_ instanceof NixStorePathNotFoundError)) {
				throw error_;
			}

			outcome = {
				error: {
					name: error_.name,
					storePath: error_.storePath
				}
			};
		}

		expect(outcome).toStrictEqual({
			error: {
				name: 'NixStorePathNotFoundError',
				storePath: appPath
			}
		});
	});

	// The daemon states the references, so one that does not name a store path is
	// refused at the reply rather than carried into the closure.
	it('rejects a daemon reference that does not name a store path', async () => {
		const client = new NixDaemonStoreClient({
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport({
						[appPath]: {
							hash: appHash,
							narSize: 123,
							references: ['/nix/store/notes.txt'],
							signatures: []
						}
					})
				)
		});

		await expect(client.queryPathInfo(appPath)).rejects.toThrow(
			InvalidNixStorePathError
		);
	});

	it.each([
		{ name: 'a trusted client', wire: 1, expected: 'trusted' },
		{ name: 'an untrusted client', wire: 2, expected: 'not-trusted' },
		{ name: 'an unset trust flag', wire: 0, expected: 'unknown' }
	])(
		'surfaces the handshake trust flag for $name',
		async ({ wire, expected }) => {
			let transport: FakeDaemonTransport | undefined;
			const client = new NixDaemonStoreClient({
				connect: () => {
					transport = new FakeDaemonTransport({}, { trust: wire });

					return Promise.resolve(transport);
				}
			});

			await expect(client.daemonTrust()).resolves.toBe(expected);
			expect(transport?.closed).toBe(true);
		}
	);

	it('rejects daemon protocol minors older than the SetOptions frame it sends', async () => {
		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			connect: () => {
				transport = new FakeDaemonTransport({}, { protocolMinor: 37 });

				return Promise.resolve(transport);
			}
		});

		let outcome:
			| { value: Awaited<ReturnType<typeof client.queryPathInfo>> }
			| {
					error: {
						name: string;
						version: UnsupportedNixDaemonProtocolError['version'];
					};
			  };
		try {
			const value = await client.queryPathInfo(appPath);
			outcome = { value };
		} catch (error_: unknown) {
			expect(error_).toBeInstanceOf(UnsupportedNixDaemonProtocolError);

			if (!(error_ instanceof UnsupportedNixDaemonProtocolError)) {
				throw error_;
			}

			outcome = {
				error: {
					name: error_.name,
					version: error_.version
				}
			};
		}

		expect(outcome).toStrictEqual({
			error: {
				name: 'UnsupportedNixDaemonProtocolError',
				version: { major: 1, minor: 37 }
			}
		});
		expect(transport?.closed).toBe(true);
	});
});

function narFrame(...values: readonly string[]): Buffer {
	const writer = new ProtocolWriter();

	for (const value of values) {
		writer.writeString(value);
	}

	return writer.bytes();
}

class SessionAbortedError extends Error {
	constructor() {
		super('Session callback aborted');
		this.name = 'SessionAbortedError';
	}
}

function pathInfo(
	storePath: StorePathString,
	hash: string,
	narSize: number,
	references: readonly StorePathString[]
): NixValidPathInfo {
	return {
		storePath,
		narHash: NixSha256Hash.fromDigest(Buffer.from(hash, 'hex')),
		narSize,
		references,
		deriver: undefined,
		ca: undefined,
		signatures: [],
		ultimate: false
	};
}
