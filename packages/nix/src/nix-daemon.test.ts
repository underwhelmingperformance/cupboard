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

import { ProtocolWriter } from '../../../tests/support/protocol-writer.ts';

import {
	connectToNixDaemon,
	NixDaemonStoreClient,
	type NixDaemonTransport,
	UnsupportedNixDaemonProtocolError
} from './nix-daemon.ts';
import {
	InvalidNixStorePathError,
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

interface FakePathInfo {
	readonly hash: string;
	readonly narSize: number;
	readonly references: readonly string[];
	readonly deriver?: string;
	readonly ca?: string;
	readonly signatures: readonly string[];
	readonly ultimate?: boolean;
}

class FakeDaemonTransport implements NixDaemonTransport {
	private readonly pendingBytes: Buffer[] = [];
	private writeCount = 0;

	closed = false;

	constructor(
		private readonly paths: Readonly<Record<string, FakePathInfo>>,
		private readonly options: {
			readonly protocolMinor?: number;
			readonly expectedSetOptions?: FakeSetOptionsFields;
			readonly expectedOverrides?: Readonly<Record<string, string>>;
		} = {}
	) {}

	write(bytes: Uint8Array): Promise<void> {
		this.writeCount += 1;

		if (this.writeCount === 1) {
			this.pendingBytes.push(
				handshakeResponse(this.options.protocolMinor ?? 38)
			);
			return Promise.resolve();
		}

		if (this.writeCount === 2) {
			this.pendingBytes.push(stringSetResponse([]));
			return Promise.resolve();
		}

		if (this.writeCount === 3) {
			this.pendingBytes.push(postHandshakeResponse());
			return Promise.resolve();
		}

		if (this.writeCount === 4) {
			const request = readSetOptionsRequest(Buffer.from(bytes));

			expect(request.overrides).toStrictEqual(
				this.options.expectedOverrides ?? {}
			);
			expect(request.overrideNames).toStrictEqual(
				[...request.overrideNames].toSorted((left, right) =>
					left.localeCompare(right)
				)
			);

			if (this.options.expectedSetOptions !== undefined) {
				expect(request.setOptions).toStrictEqual(
					this.options.expectedSetOptions
				);
			}

			this.pendingBytes.push(stderrLastResponse());
			return Promise.resolve();
		}

		this.pendingBytes.push(queryPathInfoResponse(bytes, this.paths));

		return Promise.resolve();
	}

	read(byteLength: number): Promise<Uint8Array> {
		if (byteLength === 0) {
			return Promise.resolve(new Uint8Array());
		}

		const chunk = this.pendingBytes[0];

		if (chunk === undefined) {
			throw new FakeDaemonReadUnderflowError(byteLength);
		}

		const bytes = chunk.subarray(0, byteLength);

		if (bytes.byteLength !== byteLength) {
			throw new FakeDaemonReadUnderflowError(byteLength);
		}

		this.pendingBytes[0] = chunk.subarray(byteLength);

		const remaining = this.pendingBytes[0];

		if (remaining.byteLength === 0) {
			this.pendingBytes.shift();
		}

		return Promise.resolve(bytes);
	}

	close(): Promise<void> {
		this.closed = true;
		this.pendingBytes.length = 0;

		return Promise.resolve();
	}
}

class FakeDaemonReadUnderflowError extends Error {
	constructor(public readonly byteLength: number) {
		super(`Fake daemon read underflow: ${String(byteLength)}`);
		this.name = 'FakeDaemonReadUnderflowError';
	}
}

function queryPathInfoResponse(
	request: Uint8Array,
	paths: Readonly<Record<string, FakePathInfo>>
): Buffer {
	const storePath = readRequestStorePath(Buffer.from(request));
	const pathInfo = paths[storePath];
	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);

	if (pathInfo === undefined) {
		response.writeBoolean(false);
		return response.bytes();
	}

	response.writeBoolean(true);
	response.writeString(pathInfo.deriver ?? '');
	response.writeString(pathInfo.hash);
	response.writeStringSet(pathInfo.references);
	response.writeInteger(1);
	response.writeInteger(pathInfo.narSize);
	response.writeBoolean(pathInfo.ultimate ?? false);
	response.writeStringSet(pathInfo.signatures);
	response.writeString(pathInfo.ca ?? '');

	return response.bytes();
}

interface FakeSetOptionsFields {
	readonly keepFailed: boolean;
	readonly keepGoing: boolean;
	readonly tryFallback: boolean;
	readonly maxBuildJobs: number;
	readonly maxSilentTime: number;
	readonly buildCores: number;
	readonly useSubstitutes: boolean;
}

function readSetOptionsRequest(request: Buffer): {
	readonly setOptions: FakeSetOptionsFields;
	readonly overrides: Readonly<Record<string, string>>;
	readonly overrideNames: readonly string[];
} {
	let offset = 8;
	const readInteger = (): number => {
		const value = Number(request.readBigUInt64LE(offset));
		offset += 8;

		return value;
	};
	const readString = (): string => {
		const length = readInteger();
		const value = request.subarray(offset, offset + length).toString('utf8');
		offset += length + ((8 - (length % 8)) % 8);

		return value;
	};

	const isKeepFailed = readInteger() !== 0;
	const shouldKeepGoing = readInteger() !== 0;
	const shouldTryFallback = readInteger() !== 0;
	readInteger();
	const maxBuildJobs = readInteger();
	const maxSilentTime = readInteger();
	readInteger();
	readInteger();
	readInteger();
	readInteger();
	const buildCores = readInteger();
	const shouldUseSubstitutes = readInteger() !== 0;
	const count = readInteger();
	const overrides: Record<string, string> = {};
	const overrideNames: string[] = [];

	for (let index = 0; index < count; index += 1) {
		const key = readString();
		overrideNames.push(key);
		overrides[key] = readString();
	}

	return {
		overrideNames,
		setOptions: {
			keepFailed: isKeepFailed,
			keepGoing: shouldKeepGoing,
			tryFallback: shouldTryFallback,
			maxBuildJobs,
			maxSilentTime,
			buildCores,
			useSubstitutes: shouldUseSubstitutes
		},
		overrides
	};
}

function readRequestStorePath(request: Buffer): string {
	let offset = 8;
	const length = Number(request.readBigUInt64LE(offset));
	offset += 8;

	return request.subarray(offset, offset + length).toString('utf8');
}

function handshakeResponse(protocolMinor: number): Buffer {
	const response = new ProtocolWriter();
	response.writeInteger(0x64_78_69_6f);
	response.writeInteger((1 << 8) | protocolMinor);

	return response.bytes();
}

function stringSetResponse(values: readonly string[]): Buffer {
	const response = new ProtocolWriter();
	response.writeStringSet(values);

	return response.bytes();
}

function postHandshakeResponse(): Buffer {
	const response = new ProtocolWriter();
	response.writeString('2.33.3');
	response.writeInteger(0);
	response.writeInteger(0x61_6c_74_73);

	return response.bytes();
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

function stderrLastResponse(): Buffer {
	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);

	return response.bytes();
}
