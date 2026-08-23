import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storeDirectorySchema,
	storePathBasenameSchema,
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
	ByteStreamReader,
	connectToNixDaemon,
	InvalidNixDaemonNarError,
	NixDaemonRemoteError,
	NixDaemonStoreClient,
	type NixDaemonTransport,
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
const appBasename = storePathBasenameSchema.parse(appPath.slice(11));
const libraryBasename = storePathBasenameSchema.parse(libraryPath.slice(11));

class PausableByteSource {
	private dataListener: ((chunk: Buffer) => void) | undefined;

	private readonly queued: Buffer[] = [];

	private isPaused = false;

	readonly delivered: Buffer[] = [];

	private deliverQueued(): void {
		while (!this.isPaused) {
			const chunk = this.queued.shift();

			if (chunk === undefined) {
				return;
			}

			this.delivered.push(chunk);
			this.dataListener?.(chunk);
		}
	}

	on(_event: 'data', listener: (chunk: Buffer) => void): void {
		this.dataListener = listener;
	}

	once(
		_event: 'end' | 'close' | 'error',
		_listener: (error: Error) => void
	): void {
		void _event;
		void _listener;
	}

	pause(): void {
		this.isPaused = true;
	}

	resume(): void {
		this.isPaused = false;
		this.deliverQueued();
	}

	offer(chunk: Buffer): void {
		this.queued.push(chunk);
		this.deliverQueued();
	}
}

class CloseCancellableTransport implements NixDaemonTransport {
	constructor(
		private readonly transport: NixDaemonTransport,
		private readonly cancelOperation: () => void
	) {}

	write(bytes: Uint8Array): Promise<void> {
		return this.transport.write(bytes);
	}

	read(byteLength: number): Promise<Uint8Array> {
		return this.transport.read(byteLength);
	}

	async close(): Promise<void> {
		this.cancelOperation();
		await this.transport.close();
	}
}

const testMaximumDaemonScalarBytes = 1024 * 1024;
const testMaximumDaemonCollectionEntries = 100_000;
const testMaximumDaemonStructuredEntries = 4096;
const testMaximumDaemonDerivationOutputs = 65_536;
const stderrLast = 0x61_6c_74_73;
const stderrError = 0x63_78_74_70;
const stderrStartActivity = 0x53_54_52_54;
const copyPathActivity = 100;

interface ScriptedDaemonResponses {
	readonly features?: Buffer;
	readonly postHandshake?: Buffer;
	readonly operation: Buffer;
}

class ScriptedDaemonTransport implements NixDaemonTransport {
	private readonly pending: Buffer[] = [];
	private writeCount = 0;

	readonly readsByWrite = new Map<number, number[]>();
	closed = false;

	constructor(private readonly responses: ScriptedDaemonResponses) {}

	private responseForWrite(): Buffer | undefined {
		if (this.writeCount === 1) {
			const response = new ProtocolWriter();
			response.writeInteger(0x64_78_69_6f);
			response.writeInteger((1 << 8) | 38);
			return response.bytes();
		}

		if (this.writeCount === 2) {
			return this.responses.features ?? stringSetFrame([]);
		}

		if (this.writeCount === 3) {
			return this.responses.postHandshake ?? postHandshakeFrame('2.33.3');
		}

		if (this.writeCount === 4) {
			return integerFrame(stderrLast);
		}

		return this.responses.operation;
	}

	write(): Promise<void> {
		this.writeCount += 1;
		const response = this.responseForWrite();

		if (response !== undefined) {
			this.pending.push(response);
		}

		return Promise.resolve();
	}

	read(byteLength: number): Promise<Uint8Array> {
		const reads = this.readsByWrite.get(this.writeCount) ?? [];
		reads.push(byteLength);
		this.readsByWrite.set(this.writeCount, reads);
		const available = this.pending.reduce(
			(total, chunk) => total + chunk.byteLength,
			0
		);

		if (available < byteLength) {
			throw new FakeDaemonReadUnderflowError(byteLength);
		}

		const result = Buffer.alloc(byteLength);
		let offset = 0;

		while (offset < byteLength) {
			const chunk = this.pending[0];

			if (chunk === undefined) {
				throw new FakeDaemonReadUnderflowError(byteLength);
			}

			const take = Math.min(chunk.byteLength, byteLength - offset);
			chunk.copy(result, offset, 0, take);
			offset += take;

			if (take === chunk.byteLength) {
				this.pending.shift();
				continue;
			}

			this.pending[0] = chunk.subarray(take);
		}

		return Promise.resolve(result);
	}

	close(): Promise<void> {
		this.closed = true;
		return Promise.resolve();
	}
}

function integerFrame(...values: number[]): Buffer {
	const response = new ProtocolWriter();

	for (const value of values) {
		response.writeInteger(value);
	}

	return response.bytes();
}

function stringSetFrame(values: readonly string[]): Buffer {
	const response = new ProtocolWriter();
	response.writeStringSet(values);

	return response.bytes();
}

function postHandshakeFrame(version: string): Buffer {
	const response = new ProtocolWriter();
	response.writeString(version);
	response.writeInteger(0);
	response.writeInteger(stderrLast);

	return response.bytes();
}

// Encode `actCopyPath` logger fields in worker-protocol order: store path,
// source store, destination store.
function substitutingResponse(
	buildPaths: readonly string[],
	copies: readonly { readonly storePath: string; readonly source: string }[]
): Buffer {
	const response = new ProtocolWriter();

	for (const copy of copies) {
		response.writeInteger(stderrStartActivity);
		response.writeInteger(1);
		response.writeInteger(2);
		response.writeInteger(copyPathActivity);
		response.writeString(`copying path '${copy.storePath}'`);
		response.writeInteger(3);
		response.writeInteger(1);
		response.writeString(copy.storePath);
		response.writeInteger(1);
		response.writeString(copy.source);
		response.writeInteger(1);
		response.writeString('local');
		response.writeInteger(0);
	}

	response.writeInteger(stderrLast);
	response.writeStringSet(buildPaths);
	response.writeStringSet([]);
	response.writeStringSet([]);
	response.writeInteger(0);
	response.writeInteger(0);

	return response.bytes();
}

function missingResponse(buildPaths: readonly string[]): Buffer {
	const response = new ProtocolWriter();
	response.writeInteger(stderrLast);
	response.writeStringSet(buildPaths);
	response.writeStringSet([]);
	response.writeStringSet([]);
	response.writeInteger(0);
	response.writeInteger(0);

	return response.bytes();
}

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
					realisation: JSON.stringify({ outPath: appBasename })
				},
				{
					id: `sha256:${'aa'.repeat(32)}!dev`,
					realisation: JSON.stringify({ outPath: libraryBasename })
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
					realisation: JSON.stringify({ outPath: appBasename })
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
	},
	{
		name: 'a built derivation whose output is named __proto__',
		targets: [`${buildDrvPath}^__proto__`],
		expectedTargets: [`${buildDrvPath}!__proto__`],
		result: {
			target: `${buildDrvPath}!__proto__`,
			status: 0,
			errorMessage: '',
			timesBuilt: 1,
			nonDeterministic: false,
			startTime: 100,
			stopTime: 260,
			builtOutputs: [
				{
					id: `sha256:${'aa'.repeat(32)}!__proto__`,
					realisation: JSON.stringify({ outPath: appBasename })
				}
			]
		},
		expected: {
			target: `${buildDrvPath}^__proto__`,
			outcome: {
				kind: 'built',
				outputs: Object.fromEntries([['__proto__', appPath]])
			},
			timesBuilt: 1,
			nonDeterministic: false,
			startTime: 100,
			stopTime: 260
		}
	}
];

describe('ByteStreamReader', () => {
	it('pauses the producer while a consumer read remains pending', async () => {
		const source = new PausableByteSource();
		const reader = new ByteStreamReader(source);
		const firstRead = reader.read(2);

		source.offer(Buffer.from([1, 2]));
		source.offer(Buffer.from([3, 4]));
		source.offer(Buffer.from([5, 6]));

		await expect(firstRead).resolves.toStrictEqual(Buffer.from([1, 2]));
		expect(source.delivered).toStrictEqual([Buffer.from([1, 2])]);

		await expect(reader.read(2)).resolves.toStrictEqual(Buffer.from([3, 4]));
		expect(source.delivered).toStrictEqual([
			Buffer.from([1, 2]),
			Buffer.from([3, 4])
		]);

		await expect(reader.read(2)).resolves.toStrictEqual(Buffer.from([5, 6]));
	});
});

describe('connectToNixDaemon', () => {
	// The fakes elsewhere bypass the socket transport. This integration test
	// exercises its read and write paths against a real socket, where Node calls
	// the write callback with null rather than undefined on success.
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

describe('Nix daemon response bounds', () => {
	it('rejects an oversized scalar before reading its body', async () => {
		const transport = new ScriptedDaemonTransport({
			postHandshake: integerFrame(testMaximumDaemonScalarBytes + 1),
			operation: Buffer.alloc(0)
		});
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(transport)
		});

		await expect(client.queryPathInfo(appPath)).rejects.toMatchObject({
			name: 'NixDaemonFieldTooLargeError',
			field: 'daemon version',
			maximumBytes: testMaximumDaemonScalarBytes,
			observedBytes: testMaximumDaemonScalarBytes + 1
		});
		expect(transport.readsByWrite.get(3)).toStrictEqual([8]);
	});

	it('rejects too many daemon features before reading an entry', async () => {
		const transport = new ScriptedDaemonTransport({
			features: integerFrame(testMaximumDaemonStructuredEntries + 1),
			operation: Buffer.alloc(0)
		});
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(transport)
		});

		await expect(client.queryPathInfo(appPath)).rejects.toMatchObject({
			name: 'NixDaemonCollectionTooLargeError',
			collection: 'daemon features',
			maximumEntries: testMaximumDaemonStructuredEntries,
			observedEntries: testMaximumDaemonStructuredEntries + 1
		});
		expect(transport.readsByWrite.get(2)).toStrictEqual([8]);
	});

	it('rejects a general collection before reading its first entry', async () => {
		const transport = new ScriptedDaemonTransport({
			operation: integerFrame(
				stderrLast,
				testMaximumDaemonCollectionEntries + 1
			)
		});
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(transport)
		});

		await expect(client.queryMissing([appPath])).rejects.toMatchObject({
			name: 'NixDaemonCollectionTooLargeError',
			collection: 'paths to build',
			maximumEntries: testMaximumDaemonCollectionEntries,
			observedEntries: testMaximumDaemonCollectionEntries + 1
		});
		expect(transport.readsByWrite.get(5)).toStrictEqual([8, 8]);
	});

	it('rejects too many logger fields before reading a field', async () => {
		const response = new ProtocolWriter();
		response.writeInteger(stderrStartActivity);
		response.writeInteger(1);
		response.writeInteger(2);
		response.writeInteger(3);
		response.writeString('activity');
		response.writeInteger(testMaximumDaemonStructuredEntries + 1);
		const transport = new ScriptedDaemonTransport({
			operation: response.bytes()
		});
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(transport)
		});

		await expect(client.queryPathInfo(appPath)).rejects.toMatchObject({
			name: 'NixDaemonCollectionTooLargeError',
			collection: 'logger fields',
			maximumEntries: testMaximumDaemonStructuredEntries,
			observedEntries: testMaximumDaemonStructuredEntries + 1
		});
		expect(transport.readsByWrite.get(5)).toStrictEqual([8, 8, 8, 8, 8, 8, 8]);
	});

	it('rejects too many error traces before reading a trace', async () => {
		const response = new ProtocolWriter();
		response.writeInteger(stderrError);
		response.writeString('');
		response.writeInteger(0);
		response.writeString('');
		response.writeString('');
		response.writeInteger(0);
		response.writeInteger(testMaximumDaemonStructuredEntries + 1);
		const transport = new ScriptedDaemonTransport({
			operation: response.bytes()
		});
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(transport)
		});

		await expect(client.queryPathInfo(appPath)).rejects.toMatchObject({
			name: 'NixDaemonCollectionTooLargeError',
			collection: 'error traces',
			maximumEntries: testMaximumDaemonStructuredEntries,
			observedEntries: testMaximumDaemonStructuredEntries + 1
		});
		expect(transport.readsByWrite.get(5)).toStrictEqual([8, 8, 8, 8, 8, 8, 8]);
	});

	it('rejects too many derivation outputs before reading an output', async () => {
		const transport = new ScriptedDaemonTransport({
			operation: integerFrame(
				stderrLast,
				testMaximumDaemonDerivationOutputs + 1
			)
		});
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(transport)
		});

		await expect(
			client.queryDerivationOutputPaths([buildDrvPath])
		).rejects.toMatchObject({
			name: 'NixDaemonCollectionTooLargeError',
			collection: 'derivation outputs',
			maximumEntries: testMaximumDaemonDerivationOutputs,
			observedEntries: testMaximumDaemonDerivationOutputs + 1
		});
		expect(transport.readsByWrite.get(5)).toStrictEqual([8, 8]);
	});

	it('uses the requested paths as the tighter path-info response bound', async () => {
		const transport = new ScriptedDaemonTransport({
			features: stringSetFrame(['queryPathInfos']),
			operation: integerFrame(stderrLast, 2)
		});
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(transport)
		});

		await expect(client.queryPathsInfo([appPath])).rejects.toMatchObject({
			name: 'NixDaemonCollectionTooLargeError',
			collection: 'path infos',
			maximumEntries: 1,
			observedEntries: 2
		});
		expect(transport.readsByWrite.get(5)).toStrictEqual([8, 8]);
	});

	it('accepts scalar and feature collections exactly at their limits', async () => {
		const transport = new ScriptedDaemonTransport({
			features: stringSetFrame(
				Array.from({ length: testMaximumDaemonStructuredEntries }, () => '')
			),
			postHandshake: postHandshakeFrame(
				'x'.repeat(testMaximumDaemonScalarBytes)
			),
			operation: integerFrame(stderrLast, 0)
		});
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(transport)
		});

		await expect(client.queryPathInfo(appPath)).rejects.toBeInstanceOf(
			NixStorePathNotFoundError
		);
		expect(transport.closed).toBe(true);
	});

	it('accepts a general collection exactly at its shared limit', async () => {
		const transport = new ScriptedDaemonTransport({
			operation: missingResponse(
				Array.from(
					{ length: testMaximumDaemonCollectionEntries },
					() => appPath
				)
			)
		});
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(transport)
		});

		await expect(client.queryMissing([appPath])).resolves.toStrictEqual({
			willBuild: [appPath],
			willSubstitute: [],
			unknown: [],
			downloadSize: 0,
			narSize: 0
		});
	});
});

describe('NixDaemonStoreClient copy observation', () => {
	const libraryPath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib';

	it("records each forwarded copy's source store", async () => {
		const transport = new ScriptedDaemonTransport({
			operation: substitutingResponse(
				[],
				[
					{ storePath: appPath, source: 'https://cache.nixos.org' },
					{ storePath: libraryPath, source: 'ssh://builder-1' },
					{ storePath: appPath, source: 'https://cache.nixos.org' }
				]
			)
		});
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(transport)
		});

		await client.queryMissing([appPath]);

		expect([...client.observedCopies()]).toStrictEqual([
			[appPath, ['https://cache.nixos.org']],
			[libraryPath, ['ssh://builder-1']]
		]);
	});

	it.each([
		{
			name: 'an activity of another type',
			activityType: 108,
			storePath: appPath,
			source: 'https://cache.nixos.org'
		},
		{
			name: 'a field that is not a store path',
			activityType: copyPathActivity,
			storePath: 'not a store path',
			source: 'https://cache.nixos.org'
		},
		{
			name: 'a copy with no source store',
			activityType: copyPathActivity,
			storePath: appPath,
			source: ''
		}
	])(
		'records no copy source for $name',
		async ({ activityType, storePath, source }) => {
			const response = new ProtocolWriter();
			response.writeInteger(stderrStartActivity);
			response.writeInteger(1);
			response.writeInteger(2);
			response.writeInteger(activityType);
			response.writeString('activity');
			response.writeInteger(2);
			response.writeInteger(1);
			response.writeString(storePath);
			response.writeInteger(1);
			response.writeString(source);
			response.writeInteger(0);
			response.writeInteger(stderrLast);
			response.writeStringSet([]);
			response.writeStringSet([]);
			response.writeStringSet([]);
			response.writeInteger(0);
			response.writeInteger(0);

			const transport = new ScriptedDaemonTransport({
				operation: response.bytes()
			});
			const client = new NixDaemonStoreClient({
				connect: () => Promise.resolve(transport)
			});

			await client.queryMissing([appPath]);

			expect([...client.observedCopies()]).toStrictEqual([]);
		}
	);
});

describe('NixDaemonStoreClient', () => {
	it('closes an in-flight connection and rejects with the abort reason', async () => {
		const controller = new AbortController();
		const reason = new Error('stop querying the daemon');
		let closes = 0;
		const client = new NixDaemonStoreClient({
			signal: controller.signal,
			connect: () =>
				Promise.resolve({
					write: () => Promise.resolve(),
					read: () =>
						new Promise<Uint8Array>((resolve) => {
							void resolve;
						}),
					close: () => {
						closes += 1;
						return Promise.resolve();
					}
				})
		});

		const query = client.queryValidPaths([appPath]);
		await Promise.resolve();
		controller.abort(reason);

		await expect(query).rejects.toBe(reason);
		expect(closes).toBe(1);
	});

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

	it('shares the connection limit across concurrent top-level calls', async () => {
		const firstStarted = Promise.withResolvers<undefined>();
		const releaseFirst = Promise.withResolvers<undefined>();
		let connections = 0;
		const client = new NixDaemonStoreClient({
			maxConnections: 1,
			connect: () => {
				connections += 1;
				const connection = connections;

				return Promise.resolve(
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
							async beforeOperation() {
								if (connection !== 1) {
									return;
								}

								firstStarted.resolve(undefined);
								await releaseFirst.promise;
							}
						}
					)
				);
			}
		});

		const first = client.queryPathInfo(appPath);
		await firstStarted.promise;
		const second = client.queryPathInfo(appPath);
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(connections).toBe(1);

		releaseFirst.resolve(undefined);
		await expect(Promise.all([first, second])).resolves.toStrictEqual([
			pathInfo(appPath, appHash, 123, []),
			pathInfo(appPath, appHash, 123, [])
		]);
		expect(connections).toBe(2);
	});

	it('aborts a call waiting for the shared connection limit', async () => {
		const controller = new AbortController();
		const reason = new Error('stop every daemon query');
		const firstStarted = Promise.withResolvers<undefined>();
		const releaseFirst = Promise.withResolvers<undefined>();
		let connections = 0;
		const client = new NixDaemonStoreClient({
			maxConnections: 1,
			signal: controller.signal,
			connect: () => {
				connections += 1;

				return Promise.resolve(
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
							async beforeOperation() {
								firstStarted.resolve(undefined);
								await releaseFirst.promise;
							}
						}
					)
				);
			}
		});

		const first = client.queryPathInfo(appPath);
		await firstStarted.promise;
		const second = client.queryPathInfo(appPath);
		await new Promise<void>((resolve) => setImmediate(resolve));
		controller.abort(reason);
		releaseFirst.resolve(undefined);

		await expect(Promise.allSettled([first, second])).resolves.toStrictEqual([
			{ status: 'rejected', reason },
			{ status: 'rejected', reason }
		]);
		expect(connections).toBe(1);
	});

	// max-silent-time uses a signed wire field, so negative configured values are
	// encoded unchanged.
	it('encodes a negative max-silent-time value', async () => {
		const client = new NixDaemonStoreClient({
			setOptions: { maxSilentTime: -1 },
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
								maxSilentTime: -1,
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

	it('writes the default SetOptions fields when no settings are configured', async () => {
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

	it('queries the configured substituters for paths in one daemon operation', async () => {
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

	it('reports external offers and omits paths absent from every substituter', async () => {
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
				source: 'daemon',
				storePath: appPath,
				deriver: buildDrvPath,
				references: [libraryPath],
				downloadSize: 512,
				narSize: 2048
			},
			{
				source: 'daemon',
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

	it('returns an empty substitutable-info result without opening a connection', async () => {
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

	it('cancels a blocked probing connection when a fallback sibling fails', async () => {
		const siblingFailure = new Error('sibling path query failed');
		const probingCancellation = new Error('probing connection closed');
		const queryStarted = Promise.withResolvers<undefined>();
		const blockedQuery = Promise.withResolvers<undefined>();
		const probingTransport = new FakeDaemonTransport(
			{
				[appPath]: {
					hash: appHash,
					narSize: 123,
					references: [],
					signatures: []
				}
			},
			{
				beforeOperation: () => {
					queryStarted.resolve(undefined);

					return blockedQuery.promise;
				}
			}
		);
		const transports: NixDaemonTransport[] = [
			new CloseCancellableTransport(probingTransport, () => {
				blockedQuery.reject(probingCancellation);
			}),
			new FakeDaemonTransport(
				{
					[libraryPath]: {
						hash: libraryHash,
						narSize: 456,
						references: [],
						signatures: []
					}
				},
				{
					beforeOperation: async () => {
						await queryStarted.promise;
						throw siblingFailure;
					}
				}
			)
		];
		const client = new NixDaemonStoreClient({
			maxConnections: 2,
			connect: () => {
				const transport = transports.shift();

				if (transport === undefined) {
					throw new Error('unexpected third daemon connection');
				}

				return Promise.resolve(transport);
			}
		});

		await expect(client.queryPathsInfo([appPath, libraryPath])).rejects.toBe(
			siblingFailure
		);
		expect(probingTransport.closed).toBe(true);
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

	it('encodes a provenance rebuild as daemon check mode', async () => {
		const build = buildResultCases[0];

		if (build === undefined) {
			throw new Error('The build result fixture is missing');
		}

		const client = new NixDaemonStoreClient({
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport(
						{},
						{
							builds: {
								expectedTargets: build.expectedTargets,
								expectedMode: 'check',
								results: [build.result]
							}
						}
					)
				)
		});

		await expect(
			client.buildPathsWithResults(build.targets, 'check')
		).resolves.toStrictEqual([build.expected]);
	});

	it('rejects a build status outside the Nix 2.34 worker protocol table', async () => {
		const build = buildResultCases[0];

		if (build === undefined) {
			throw new Error('The build result fixture is missing');
		}

		const client = new NixDaemonStoreClient({
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport(
						{},
						{
							builds: {
								expectedTargets: build.expectedTargets,
								results: [{ ...build.result, status: 15 }]
							}
						}
					)
				)
		});

		await expect(client.buildPathsWithResults(build.targets)).rejects.toThrow(
			'unknown build status 15'
		);
	});

	it('accepts an absolute realisation output inside the active store directory', async () => {
		const build = buildResultCases[5];

		if (build === undefined) {
			throw new Error('The build result fixture is missing');
		}

		const result = {
			...build.result,
			builtOutputs: [
				{
					id: `sha256:${'bb'.repeat(32)}!out`,
					realisation: JSON.stringify({ outPath: appPath })
				}
			]
		};
		const client = new NixDaemonStoreClient({
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport(
						{},
						{
							builds: {
								expectedTargets: build.expectedTargets,
								results: [result]
							}
						}
					)
				)
		});

		await expect(
			client.buildPathsWithResults(build.targets)
		).resolves.toStrictEqual([build.expected]);
	});

	it('rejects duplicate output names in one keyed build result', async () => {
		const build = buildResultCases[0];

		if (build === undefined) {
			throw new Error('The build result fixture is missing');
		}

		const duplicate = build.result.builtOutputs[0];

		if (duplicate === undefined) {
			throw new Error('The build result fixture has no output to duplicate');
		}

		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			connect: () => {
				transport = new FakeDaemonTransport(
					{},
					{
						builds: {
							expectedTargets: build.expectedTargets,
							results: [
								{
									...build.result,
									builtOutputs: [...build.result.builtOutputs, duplicate]
								}
							]
						}
					}
				);

				return Promise.resolve(transport);
			}
		});

		await expect(client.buildPathsWithResults(build.targets)).rejects.toThrow(
			'keyed build result contains duplicate output name: out'
		);
		expect(transport?.closed).toBe(true);
	});

	it('decodes a realisation basename against the active store directory', async () => {
		const customStoreDirectory = storeDirectorySchema.parse('/custom/store');
		const customAppPath = storePathSchema.parse(
			`${customStoreDirectory}/${appBasename}`
		);
		const build = buildResultCases[5];

		if (build === undefined) {
			throw new Error('The build result fixture is missing');
		}

		const client = new NixDaemonStoreClient({
			storeDirectory: customStoreDirectory,
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport(
						{},
						{
							builds: {
								expectedTargets: build.expectedTargets,
								results: [build.result]
							}
						}
					)
				)
		});

		await expect(
			client.buildPathsWithResults(build.targets)
		).resolves.toStrictEqual([
			{
				...build.expected,
				outcome: {
					kind: 'resolves-to-already-valid',
					outputs: { out: customAppPath }
				}
			}
		]);
	});

	it('rejects an absolute realisation output outside the active store directory', async () => {
		const build = buildResultCases[5];

		if (build === undefined) {
			throw new Error('The build result fixture is missing');
		}

		const client = new NixDaemonStoreClient({
			storeDirectory: storeDirectorySchema.parse('/custom/store'),
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport(
						{},
						{
							builds: {
								expectedTargets: build.expectedTargets,
								results: [
									{
										...build.result,
										builtOutputs: [
											{
												id: `sha256:${'bb'.repeat(32)}!out`,
												realisation: JSON.stringify({ outPath: appPath })
											}
										]
									}
								]
							}
						}
					)
				)
		});

		await expect(client.buildPathsWithResults(build.targets)).rejects.toThrow(
			NixDaemonRemoteError
		);
	});

	it('returns an empty build result without opening a connection', async () => {
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

	// This test reassembles 150 kilobytes of NAR across a dozen frames. Every
	// other test here moves a few hundred bytes, and the full parallel check can
	// push this one past the five-second default. Give it the same timeout as the
	// server suites and leave every other test on the default.
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
	}, 30_000);

	it('shares the connection limit across concurrent NAR streams', async () => {
		const frames = [
			narFrame('nix-archive-1'),
			narFrame('(', 'type', 'regular', 'contents', 'nar contents', ')')
		];
		const firstStarted = Promise.withResolvers<undefined>();
		const releaseFirst = Promise.withResolvers<undefined>();
		let connections = 0;
		const client = new NixDaemonStoreClient({
			maxConnections: 1,
			connect: () => {
				connections += 1;
				const connection = connections;

				return Promise.resolve(
					new FakeDaemonTransport(
						{},
						{
							nar: { expectedPath: appPath, frames },
							async beforeOperation() {
								if (connection !== 1) {
									return;
								}

								firstStarted.resolve(undefined);
								await releaseFirst.promise;
							}
						}
					)
				);
			}
		});

		const first = Array.fromAsync(client.narFromPath(appPath));
		await firstStarted.promise;
		const second = Array.fromAsync(client.narFromPath(appPath));
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(connections).toBe(1);

		releaseFirst.resolve(undefined);
		const archives = await Promise.all([first, second]);
		expect(archives.map((chunks) => Buffer.concat(chunks))).toStrictEqual([
			Buffer.concat(frames),
			Buffer.concat(frames)
		]);
		expect(connections).toBe(2);
	});

	it('reads a derivation from the single regular file in its NAR', async () => {
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

	it('rejects malformed NAR bytes with a typed error', async () => {
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

	it('closes a paused NAR stream when its client is aborted', async () => {
		const controller = new AbortController();
		const frames = [
			narFrame('nix-archive-1'),
			narFrame('(', 'type', 'regular', 'contents', 'nar contents', ')')
		];
		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			maxConnections: 1,
			signal: controller.signal,
			connect: () => {
				transport = new FakeDaemonTransport(
					{},
					{ nar: { expectedPath: appPath, frames } }
				);

				return Promise.resolve(transport);
			}
		});
		const stream = client.narFromPath(appPath)[Symbol.asyncIterator]();

		await expect(stream.next()).resolves.toMatchObject({ done: false });

		try {
			controller.abort(new Error('cancel paused NAR stream'));
			await new Promise<void>((resolve) => setImmediate(resolve));

			expect(transport?.closed).toBe(true);
		} finally {
			await stream.return?.();
		}
	});

	it('builds and queries with temporary roots on one session connection', async () => {
		const build = buildResultCases[0];

		if (build === undefined) {
			throw new Error('The build result fixture is missing');
		}

		const transports: FakeDaemonTransport[] = [];
		const client = new NixDaemonStoreClient({
			connect: () => {
				const transport = new FakeDaemonTransport(
					{
						[appPath]: {
							hash: appHash,
							narSize: 123,
							references: [],
							signatures: []
						}
					},
					{
						builds: {
							expectedTargets: build.expectedTargets,
							results: [build.result]
						}
					}
				);
				transports.push(transport);

				return Promise.resolve(transport);
			}
		});

		const outcome = await client.withConnection(async (session) => {
			const builds = await session.buildPathsWithResults(build.targets);
			await session.addTempRoot(appPath);
			await session.addTempRoot(libraryPath);

			return {
				builds,
				valid: await session.queryValidPaths([libraryPath, appPath]),
				info: await session.queryPathInfo(appPath)
			};
		});

		expect(outcome).toStrictEqual({
			builds: [build.expected],
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

	it('serialises concurrent operations on one session connection', async () => {
		let activeOperations = 0;
		let maximumActiveOperations = 0;
		const transport = new FakeDaemonTransport(
			{
				[appPath]: {
					hash: appHash,
					narSize: 123,
					references: [],
					signatures: []
				}
			},
			{
				beforeOperation: async () => {
					activeOperations += 1;
					maximumActiveOperations = Math.max(
						maximumActiveOperations,
						activeOperations
					);

					await new Promise<void>((resolve) => setImmediate(resolve));
					activeOperations -= 1;
				}
			}
		);
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(transport)
		});

		const result = await client.withConnection(async (session) => {
			const [valid, info] = await Promise.all([
				session.queryValidPaths([appPath]),
				session.queryPathInfo(appPath)
			]);

			return { valid, info };
		});

		expect({ maximumActiveOperations, result }).toStrictEqual({
			maximumActiveOperations: 1,
			result: {
				valid: [appPath],
				info: pathInfo(appPath, appHash, 123, [])
			}
		});
	});

	it('keeps the session exclusive until a concurrent NAR stream is drained', async () => {
		const frames = [
			narFrame('nix-archive-1'),
			narFrame('(', 'type', 'regular', 'contents', 'session nar', ')')
		];
		let activeOperations = 0;
		let maximumActiveOperations = 0;
		const transport = new FakeDaemonTransport(
			{
				[appPath]: {
					hash: appHash,
					narSize: 123,
					references: [],
					signatures: []
				}
			},
			{
				nar: { expectedPath: appPath, frames },
				beforeOperation: async () => {
					activeOperations += 1;
					maximumActiveOperations = Math.max(
						maximumActiveOperations,
						activeOperations
					);

					await new Promise<void>((resolve) => setImmediate(resolve));
					activeOperations -= 1;
				}
			}
		);
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(transport)
		});

		const result = await client.withConnection(async (session) => {
			const [archive, info] = await Promise.all([
				Array.fromAsync(session.narFromPath(appPath)),
				session.queryPathInfo(appPath)
			]);

			return { archive: Buffer.concat(archive), info };
		});

		expect({ maximumActiveOperations, result }).toStrictEqual({
			maximumActiveOperations: 1,
			result: {
				archive: Buffer.concat(frames),
				info: pathInfo(appPath, appHash, 123, [])
			}
		});
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

	it('aborts and closes a session while its callback is parked', async () => {
		const controller = new AbortController();
		const reason = new Error('cancel parked session');
		const entered = Promise.withResolvers<undefined>();
		const releaseCallback = Promise.withResolvers<undefined>();
		const callbackCompleted = Promise.withResolvers<undefined>();
		let transport: FakeDaemonTransport | undefined;
		const client = new NixDaemonStoreClient({
			signal: controller.signal,
			connect: () => {
				transport = new FakeDaemonTransport({});

				return Promise.resolve(transport);
			}
		});
		const run = client.withConnection(async (session) => {
			await session.addTempRoot(appPath);
			entered.resolve(undefined);

			try {
				await releaseCallback.promise;
			} finally {
				callbackCompleted.resolve(undefined);
			}
		});
		await entered.promise;

		controller.abort(reason);
		const observeRun = async (): Promise<
			| { readonly kind: 'resolved' }
			| { readonly error: unknown; readonly kind: 'rejected' }
		> => {
			try {
				await run;

				return { kind: 'resolved' };
			} catch (error) {
				return { error, kind: 'rejected' };
			}
		};
		const outcome = await Promise.race([
			observeRun(),
			new Promise<{ readonly kind: 'pending' }>((resolve) => {
				setImmediate(() => {
					resolve({ kind: 'pending' });
				});
			})
		]);

		try {
			expect({ outcome, closed: transport?.closed }).toStrictEqual({
				outcome: { error: reason, kind: 'rejected' },
				closed: true
			});
		} finally {
			releaseCallback.resolve(undefined);
			await callbackCompleted.promise;
		}
	});

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

	it('returns an empty QueryMissing result without opening a connection', async () => {
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

	it('does not reuse idle connections when max-connection-age is zero', async () => {
		const appDrvPath = storePathSchema.parse(
			'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv'
		);
		const libraryDrvPath = storePathSchema.parse(
			'/nix/store/5123456789abcdfghijklmnpqrsvwxyz-lib.drv'
		);
		let connections = 0;
		const client = new NixDaemonStoreClient({
			maxConnections: 1,
			maxConnectionAge: 0,
			connect: () => {
				connections += 1;

				return Promise.resolve(
					new FakeDaemonTransport(
						{},
						{
							derivationOutputs: {
								[appDrvPath]: { out: appPath },
								[libraryDrvPath]: { out: libraryPath }
							}
						}
					)
				);
			}
		});

		await expect(
			client.queryDerivationOutputPaths([appDrvPath, libraryDrvPath])
		).resolves.toStrictEqual([appPath, libraryPath]);
		expect(connections).toBe(2);
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

		// The root forms the first frontier; its two references form the next,
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

	it('rejects an invalid store-path reference from the daemon', async () => {
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
		'reports the handshake trust flag for $name',
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

	it('rejects protocol minors below the SetOptions requirement', async () => {
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
