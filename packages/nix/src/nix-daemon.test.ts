import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { describe, expect, it } from 'vitest';

import { ProtocolWriter } from '../../../tests/support/protocol-writer.ts';

import {
	NixDaemonStoreClient,
	type NixDaemonTransport,
	UnsupportedNixDaemonProtocolError
} from './nix-daemon.ts';
import {
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from './nix-store.ts';

const appPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const appDrvPath = '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv';
const libraryPath = '/nix/store/2123456789abcdfghijklmnpqrsvwxyz-lib';
const runtimePath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime';
const appHash = '11'.repeat(32);
const libraryHash = '22'.repeat(32);
const runtimeHash = '33'.repeat(32);

describe('NixDaemonStoreClient', () => {
	it('asks every configured mass-query substituter for paths directly', async () => {
		const client = new NixDaemonStoreClient({
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport(
						{},
						{
							substitutable: {
								expectedPaths: [appPath, libraryPath, runtimePath],
								paths: [appPath, runtimePath]
							}
						}
					)
				)
		});

		await expect(
			client.querySubstitutablePaths([
				runtimePath,
				appPath,
				libraryPath,
				appPath
			])
		).resolves.toStrictEqual([appPath, runtimePath]);
	});

	it('reads realised derivation outputs through pooled daemon connections', async () => {
		const libraryDrvPath =
			'/nix/store/5123456789abcdfghijklmnpqrsvwxyz-lib.drv';
		let connections = 0;
		const client = new NixDaemonStoreClient({
			connect: () => {
				connections += 1;

				return Promise.resolve(
					new FakeDaemonTransport(
						{},
						{
							derivationOutputs: {
								[appDrvPath]: { out: appPath, dev: undefined },
								[libraryDrvPath]: { out: libraryPath }
							}
						}
					)
				);
			}
		});

		await expect(
			client.queryDerivationOutputPaths([
				libraryDrvPath,
				appDrvPath,
				libraryDrvPath
			])
		).resolves.toStrictEqual([appPath, libraryPath]);
		expect(connections).toBe(2);
	});

	it('bounds concurrent derivation output queries to the daemon pool size', async () => {
		const drvPaths = Array.from(
			{ length: 17 },
			(_, index) =>
				`/nix/store/${String(index).padStart(32, '0')}-output-${String(index)}.drv`
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

	it('forwards canonical daemon overrides on every connection', async () => {
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
					new FakeDaemonTransport(paths, {
						expectedOverrides: overrides
					})
				);
			}
		});

		await expect(
			client.queryPathsInfo([appPath, libraryPath])
		).resolves.toStrictEqual([
			pathInfo(appPath, appHash, 123, []),
			pathInfo(libraryPath, libraryHash, 456, [])
		]);
		expect(connections).toBe(2);
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

	it('reads path info through the Nix daemon protocol', async () => {
		const client = new NixDaemonStoreClient({
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport({
						[appPath]: {
							hash: appHash,
							narSize: 123,
							references: [libraryPath, runtimePath],
							deriver: '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv',
							ca: 'fixed:r:sha256:hash',
							signatures: ['cache:first', 'cache:second'],
							ultimate: true
						}
					})
				)
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
	});

	it('reads several path infos through the pooled daemon protocol', async () => {
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
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(new FakeDaemonTransport(paths))
		});

		await expect(
			client.queryPathsInfo([libraryPath, appPath])
		).resolves.toStrictEqual([
			pathInfo(libraryPath, libraryHash, 456, []),
			pathInfo(appPath, appHash, 123, [libraryPath])
		]);
	});

	it('uses the negotiated path-info batch operation', async () => {
		const missingPath = '/nix/store/9123456789abcdfghijklmnpqrsvwxyz-missing';
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
		const client = new NixDaemonStoreClient({
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport(paths, {
						features: ['queryPathInfos'],
						expectedPathInfoBatch: [appPath, libraryPath, missingPath]
					})
				)
		});

		await expect(
			client.queryValidPathsInfo([libraryPath, missingPath, appPath])
		).resolves.toStrictEqual([
			pathInfo(libraryPath, libraryHash, 456, []),
			pathInfo(appPath, appHash, 123, [libraryPath])
		]);
	});

	it('returns only registered paths from a pooled valid-path query', async () => {
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
			client.queryValidPathsInfo([libraryPath, appPath])
		).resolves.toStrictEqual([pathInfo(appPath, appHash, 123, [])]);
	});

	it('queries valid paths in one daemon operation', async () => {
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
			client.queryValidPaths([libraryPath, appPath, appPath])
		).resolves.toStrictEqual([appPath]);
	});

	it('does not start a queued path query after a batch query fails', async () => {
		const missingPath = `/nix/store/${'0'.repeat(32)}-missing`;
		const validPaths = Array.from(
			{ length: 16 },
			(_, index) =>
				`/nix/store/${String(index + 1).padStart(32, '0')}-valid-${String(index + 1)}`
		);
		const queuedPath = `/nix/store/${'16'.padStart(32, '0')}-valid-16`;
		const paths = Object.fromEntries(
			validPaths.map((storePath) => [
				storePath,
				{
					hash: appHash,
					narSize: 123,
					references: [],
					signatures: []
				}
			])
		);
		const startedPaths = new Set<string>();
		const blocked = Promise.withResolvers<undefined>().promise;
		const client = new NixDaemonStoreClient({
			connect: () =>
				Promise.resolve(
					new FakeDaemonTransport(paths, {
						async beforeOperation(request) {
							const storePath = readRequestStorePath(request);
							startedPaths.add(storePath);

							if (storePath !== missingPath) {
								await blocked;
							}
						}
					})
				)
		});

		await expect(
			client.queryPathsInfo([missingPath, ...validPaths])
		).rejects.toStrictEqual(new NixStorePathNotFoundError(missingPath));
		await Promise.resolve();

		expect(startedPaths.has(queuedPath)).toBe(false);
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
		let connections = 0;
		const client = new NixDaemonStoreClient({
			connect: () => {
				connections += 1;

				return Promise.resolve(
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
							references: [],
							signatures: []
						},
						[runtimePath]: {
							hash: runtimeHash,
							narSize: 789,
							references: [],
							signatures: []
						}
					})
				);
			}
		});

		await expect(client.resolveClosure([appPath])).resolves.toStrictEqual([
			pathInfo(appPath, appHash, 123, [libraryPath, runtimePath]),
			pathInfo(libraryPath, libraryHash, 456, []),
			pathInfo(runtimePath, runtimeHash, 789, [])
		]);

		// The root is one frontier on its own; its two references form the next,
		// so the pool opens a second connection to query them at the same time.
		expect(connections).toBe(2);
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
	private phase:
		'handshake' | 'features' | 'post-handshake' | 'set-options' | 'ready' =
		'handshake';

	closed = false;

	constructor(
		private readonly paths: Readonly<Record<string, FakePathInfo>>,
		private readonly options: {
			readonly protocolMinor?: number;
			readonly substitutable?: {
				readonly expectedPaths: readonly string[];
				readonly paths: readonly string[];
			};
			readonly derivationOutputs?: Readonly<
				Record<string, Readonly<Record<string, string | undefined>>>
			>;
			readonly expectedOverrides?: Readonly<Record<string, string>>;
			readonly expectedSetOptions?: {
				readonly keepFailed: boolean;
				readonly keepGoing: boolean;
				readonly tryFallback: boolean;
				readonly maxBuildJobs: number;
				readonly maxSilentTime: number;
				readonly buildCores: number;
				readonly useSubstitutes: boolean;
			};
			readonly features?: readonly string[];
			readonly expectedPathInfoBatch?: readonly string[];
			readonly beforeOperation?: (request: Buffer) => Promise<void>;
		} = {}
	) {}

	async write(bytes: Uint8Array): Promise<void> {
		if (this.phase === 'handshake') {
			this.phase = 'features';
			this.pendingBytes.push(
				handshakeResponse(this.options.protocolMinor ?? 38)
			);
			return;
		}

		if (this.phase === 'features') {
			this.phase = 'post-handshake';
			this.pendingBytes.push(stringSetResponse(this.options.features ?? []));
			return;
		}

		if (this.phase === 'post-handshake') {
			this.phase = 'set-options';
			this.pendingBytes.push(postHandshakeResponse());
			return;
		}

		if (this.phase === 'set-options') {
			const request = readSetOptionsRequest(Buffer.from(bytes));

			expect(request.overrides).toStrictEqual(
				this.options.expectedOverrides ?? {}
			);

			if (this.options.expectedSetOptions !== undefined) {
				expect(request.setOptions).toStrictEqual(
					this.options.expectedSetOptions
				);
			}

			this.phase = 'ready';
			this.pendingBytes.push(stderrLastResponse());
			return;
		}

		const request = Buffer.from(bytes);
		await this.options.beforeOperation?.(request);
		this.pendingBytes.push(
			daemonOperationResponse(request, this.paths, this.options)
		);
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

function daemonOperationResponse(
	request: Buffer,
	paths: Readonly<Record<string, FakePathInfo>>,
	options: {
		readonly substitutable?: {
			readonly expectedPaths: readonly string[];
			readonly paths: readonly string[];
		};
		readonly derivationOutputs?: Readonly<
			Record<string, Readonly<Record<string, string | undefined>>>
		>;
		readonly expectedPathInfoBatch?: readonly string[];
	}
): Buffer {
	const operation = Number(request.readBigUInt64LE(0));

	if (operation === 26) {
		return queryPathInfoResponse(request, paths);
	}

	if (operation === 31) {
		return queryValidPathsResponse(request, paths);
	}

	if (operation === 32) {
		return querySubstitutablePathsResponse(request, options.substitutable);
	}

	if (operation === 41) {
		return queryDerivationOutputMapResponse(
			request,
			options.derivationOutputs ?? {}
		);
	}

	if (operation === 50) {
		return queryPathInfosResponse(
			request,
			paths,
			options.expectedPathInfoBatch
		);
	}

	throw new Error(`Unexpected fake daemon operation: ${String(operation)}`);
}

function queryPathInfosResponse(
	request: Buffer,
	paths: Readonly<Record<string, FakePathInfo>>,
	expectedPaths: readonly string[] | undefined
): Buffer {
	const requested = readRequestStringSet(request);

	if (expectedPaths !== undefined) {
		expect(requested).toStrictEqual(expectedPaths);
	}

	const infos = requested.flatMap((storePath) => {
		const info = paths[storePath];

		return info === undefined ? [] : [{ storePath, info }];
	});
	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);
	response.writeInteger(infos.length);

	for (const { storePath, info } of infos) {
		response.writeString(storePath);
		writeUnkeyedPathInfo(response, info);
	}

	return response.bytes();
}

function queryValidPathsResponse(
	request: Buffer,
	paths: Readonly<Record<string, FakePathInfo>>
): Buffer {
	const requested = readRequestStringSet(request);
	const substituteFlagOffset = request.byteLength - 8;

	expect(Number(request.readBigUInt64LE(substituteFlagOffset))).toBe(0);

	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);
	response.writeStringSet(
		requested.filter((storePath) => paths[storePath] !== undefined)
	);

	return response.bytes();
}

function queryPathInfoResponse(
	request: Buffer,
	paths: Readonly<Record<string, FakePathInfo>>
): Buffer {
	const storePath = readRequestStorePath(request);
	const pathInfo = paths[storePath];
	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);

	if (pathInfo === undefined) {
		response.writeBoolean(false);
		return response.bytes();
	}

	response.writeBoolean(true);
	writeUnkeyedPathInfo(response, pathInfo);

	return response.bytes();
}

function writeUnkeyedPathInfo(
	response: ProtocolWriter,
	pathInfo: FakePathInfo
): void {
	response.writeString(pathInfo.deriver ?? '');
	response.writeString(pathInfo.hash);
	response.writeStringSet(pathInfo.references);
	response.writeInteger(1);
	response.writeInteger(pathInfo.narSize);
	response.writeBoolean(pathInfo.ultimate ?? false);
	response.writeStringSet(pathInfo.signatures);
	response.writeString(pathInfo.ca ?? '');
}

function querySubstitutablePathsResponse(
	request: Buffer,
	substitutable:
		| {
				readonly expectedPaths: readonly string[];
				readonly paths: readonly string[];
		  }
		| undefined
): Buffer {
	if (substitutable === undefined) {
		throw new Error('Unexpected QuerySubstitutablePaths request');
	}

	expect(readRequestStringSet(request)).toStrictEqual(
		substitutable.expectedPaths
	);

	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);
	response.writeStringSet(substitutable.paths);

	return response.bytes();
}

function queryDerivationOutputMapResponse(
	request: Buffer,
	outputs: Readonly<
		Record<string, Readonly<Record<string, string | undefined>>>
	>
): Buffer {
	const drvPath = readRequestStorePath(request);
	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);
	const entries = Object.entries(outputs[drvPath] ?? {}).toSorted(
		([left], [right]) => left.localeCompare(right)
	);
	response.writeInteger(entries.length);

	for (const [output, storePath] of entries) {
		response.writeString(output);
		response.writeString(storePath ?? '');
	}

	return response.bytes();
}

function readRequestStorePath(request: Buffer): string {
	let offset = 8;
	const length = Number(request.readBigUInt64LE(offset));
	offset += 8;

	return request.subarray(offset, offset + length).toString('utf8');
}

function readRequestStringSet(request: Buffer): string[] {
	let offset = 8;
	const count = Number(request.readBigUInt64LE(offset));
	offset += 8;
	const values: string[] = [];

	for (let index = 0; index < count; index += 1) {
		const length = Number(request.readBigUInt64LE(offset));
		offset += 8;
		values.push(request.subarray(offset, offset + length).toString('utf8'));
		offset += length + ((8 - (length % 8)) % 8);
	}

	return values;
}

function readSetOptionsRequest(request: Buffer): {
	readonly setOptions: {
		readonly keepFailed: boolean;
		readonly keepGoing: boolean;
		readonly tryFallback: boolean;
		readonly maxBuildJobs: number;
		readonly maxSilentTime: number;
		readonly buildCores: number;
		readonly useSubstitutes: boolean;
	};
	readonly overrides: Readonly<Record<string, string>>;
} {
	let offset = 8;
	const readInteger = (): number => {
		const value = Number(request.readBigUInt64LE(offset));
		offset += 8;

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
	const count = Number(request.readBigUInt64LE(offset));
	offset += 8;
	const overrides: Record<string, string> = {};

	for (let index = 0; index < count; index += 1) {
		const key = readString();
		const value = readString();
		overrides[key] = value;
	}

	return {
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

	function readString(): string {
		const length = Number(request.readBigUInt64LE(offset));
		offset += 8;
		const value = request.subarray(offset, offset + length).toString('utf8');
		offset += length + ((8 - (length % 8)) % 8);

		return value;
	}
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
	storePath: string,
	hash: string,
	narSize: number,
	references: readonly string[]
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
