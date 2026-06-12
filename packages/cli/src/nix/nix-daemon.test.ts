import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ProtocolWriter } from '../../../../tests/support/protocol-writer.ts';

import { NixSha256Hash } from './nar.ts';
import {
	connectToNixDaemon,
	NixDaemonStoreClient,
	type NixDaemonTransport,
	UnsupportedNixDaemonProtocolError
} from './nix-daemon.ts';
import {
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from './nix-store.ts';

const appPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const libraryPath = '/nix/store/2123456789abcdfghijklmnpqrsvwxyz-lib';
const runtimePath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime';
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
			transport.close();

			expect([...echoed]).toStrictEqual([1, 2, 3, 4]);
		} finally {
			server.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe('NixDaemonStoreClient', () => {
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
							signatures: ['cache:first', 'cache:second']
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
			signatures: ['cache:first', 'cache:second']
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

	it('rejects daemon misses with a typed path error', async () => {
		const client = new NixDaemonStoreClient({
			connect: () => Promise.resolve(new FakeDaemonTransport({}))
		});

		await expect(client.queryPathInfo(appPath)).rejects.toThrow(
			NixStorePathNotFoundError
		);
	});

	it('rejects daemon protocol minors older than the SetOptions frame it sends', async () => {
		const client = new NixDaemonStoreClient({
			connect: () =>
				Promise.resolve(new FakeDaemonTransport({}, { protocolMinor: 37 }))
		});

		await expect(client.queryPathInfo(appPath)).rejects.toThrow(
			UnsupportedNixDaemonProtocolError
		);
	});
});

interface FakePathInfo {
	readonly hash: string;
	readonly narSize: number;
	readonly references: readonly string[];
	readonly deriver?: string;
	readonly ca?: string;
	readonly signatures: readonly string[];
}

class FakeDaemonTransport implements NixDaemonTransport {
	private readonly pendingBytes: Buffer[] = [];
	private writeCount = 0;

	constructor(
		private readonly paths: Readonly<Record<string, FakePathInfo>>,
		private readonly options: { readonly protocolMinor?: number } = {}
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

	close(): void {
		this.pendingBytes.length = 0;
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
	response.writeBoolean(false);
	response.writeStringSet(pathInfo.signatures);
	response.writeString(pathInfo.ca ?? '');

	return response.bytes();
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
		signatures: []
	};
}

function stderrLastResponse(): Buffer {
	const response = new ProtocolWriter();
	response.writeInteger(0x61_6c_74_73);

	return response.bytes();
}
