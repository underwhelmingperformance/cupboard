import { createConnection, type Socket } from 'node:net';

import { NixSha256Hash } from './nar.ts';
import {
	type NixStoreClient,
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from './nix-store.ts';

const defaultDaemonSocketPath = '/nix/var/nix/daemon-socket/socket';
const workerMagic1 = 0x6e_69_78_63;
const workerMagic2 = 0x64_78_69_6f;
const protocolMajor = 1;
const protocolMinor = 38;
const minimumProtocolMinor = 38;

const opSetOptions = 19;
const opQueryPathInfo = 26;

const stderrNext = 0x6f_6c_6d_67;
const stderrRead = 0x64_61_74_61;
const stderrWrite = 0x64_61_74_16;
const stderrLast = 0x61_6c_74_73;
const stderrError = 0x63_78_74_70;
const stderrStartActivity = 0x53_54_52_54;
const stderrStopActivity = 0x53_54_4f_50;
const stderrResult = 0x52_53_4c_54;

export interface NixDaemonStoreClientOptions {
	readonly socketPath?: string;
	readonly connect?: NixDaemonConnector;
}

export type NixDaemonConnector = (
	socketPath: string
) => Promise<NixDaemonTransport>;

export interface NixDaemonTransport {
	write(bytes: Uint8Array): Promise<void>;
	read(byteLength: number): Promise<Uint8Array>;
	close(): void;
}

interface NixDaemonProtocolVersion {
	readonly major: number;
	readonly minor: number;
}

interface UnkeyedDaemonPathInfo {
	readonly deriver?: string;
	readonly narHash: NixSha256Hash;
	readonly references: readonly string[];
	readonly narSize: number;
	readonly ca?: string;
	readonly signatures: readonly string[];
}

export abstract class NixDaemonError extends Error {}

export class NixDaemonConnectionError extends NixDaemonError {
	constructor(
		public readonly socketPath: string,
		public override readonly cause: unknown
	) {
		super(`Could not connect to Nix daemon: ${socketPath}`);
		this.name = 'NixDaemonConnectionError';
	}
}

export class NixDaemonProtocolMismatchError extends NixDaemonError {
	constructor(public readonly magic: number) {
		super(`Nix daemon protocol mismatch: ${magic.toString(16)}`);
		this.name = 'NixDaemonProtocolMismatchError';
	}
}

export class UnsupportedNixDaemonProtocolError extends NixDaemonError {
	constructor(public readonly version: NixDaemonProtocolVersion) {
		super(
			`Unsupported Nix daemon protocol version: ${String(version.major)}.${String(version.minor)}`
		);
		this.name = 'UnsupportedNixDaemonProtocolError';
	}
}

export class NixDaemonRemoteError extends NixDaemonError {
	constructor(public readonly messageFromDaemon: string) {
		super(`Nix daemon error: ${messageFromDaemon}`);
		this.name = 'NixDaemonRemoteError';
	}
}

export class UnsupportedNixDaemonStderrReadError extends NixDaemonError {
	constructor(public readonly length: number) {
		super(`Nix daemon requested unsupported stdin read: ${String(length)}`);
		this.name = 'UnsupportedNixDaemonStderrReadError';
	}
}

export class UnknownNixDaemonStderrMessageError extends NixDaemonError {
	constructor(public readonly messageType: number) {
		super(`Unknown Nix daemon stderr message: ${messageType.toString(16)}`);
		this.name = 'UnknownNixDaemonStderrMessageError';
	}
}

export class InvalidNixDaemonHashError extends NixDaemonError {
	constructor(public readonly hash: string) {
		super(`Invalid Nix daemon SHA-256 hash: ${hash}`);
		this.name = 'InvalidNixDaemonHashError';
	}
}

export class NixDaemonStoreClient implements NixStoreClient {
	private readonly socketPath: string;

	private readonly connect: NixDaemonConnector;

	constructor(options: NixDaemonStoreClientOptions = {}) {
		this.socketPath = options.socketPath ?? defaultDaemonSocketPath;
		this.connect = options.connect ?? connectToNixDaemon;
	}

	private async openConnection(): Promise<NixDaemonConnection> {
		const transport = await this.connect(this.socketPath);
		const connection = new NixDaemonConnection(transport);

		await connection.initialise();

		return connection;
	}

	async resolveClosure(
		storePaths: readonly string[]
	): Promise<readonly NixValidPathInfo[]> {
		const connection = await this.openConnection();

		try {
			return await resolveClosureWithConnection(connection, storePaths);
		} finally {
			connection.close();
		}
	}

	async queryPathInfo(storePath: string): Promise<NixValidPathInfo> {
		const connection = await this.openConnection();

		try {
			return await connection.queryPathInfo(storePath);
		} finally {
			connection.close();
		}
	}
}

export async function connectToNixDaemon(
	socketPath: string
): Promise<NixDaemonTransport> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);

		socket.once('connect', () => {
			resolve(new SocketNixDaemonTransport(socket));
		});
		socket.once('error', (error) => {
			reject(new NixDaemonConnectionError(socketPath, error));
		});
	});
}

class NixDaemonConnection {
	private version: NixDaemonProtocolVersion = {
		major: protocolMajor,
		minor: protocolMinor
	};

	constructor(private readonly transport: NixDaemonTransport) {}

	private async handshake(): Promise<void> {
		const request = new NixDaemonWriter();
		request.writeInteger(workerMagic1);
		request.writeInteger(versionToWire(this.version));

		await this.transport.write(request.bytes());

		const magic = await this.readInteger();

		if (magic !== workerMagic2) {
			throw new NixDaemonProtocolMismatchError(magic);
		}

		const daemonVersion = versionFromWire(await this.readInteger());

		if (
			daemonVersion.major !== protocolMajor ||
			daemonVersion.minor < minimumProtocolMinor
		) {
			throw new UnsupportedNixDaemonProtocolError(daemonVersion);
		}

		this.version = {
			major: protocolMajor,
			minor: Math.min(protocolMinor, daemonVersion.minor)
		};

		if (this.version.minor < 38) {
			return;
		}

		const features = new NixDaemonWriter();
		features.writeStringSet([]);

		await this.transport.write(features.bytes());
		await this.readStringSet();
	}

	private async postHandshake(): Promise<void> {
		const request = new NixDaemonWriter();

		if (this.version.minor >= 14) {
			request.writeInteger(0);
		}

		if (this.version.minor >= 11) {
			request.writeBoolean(false);
		}

		await this.transport.write(request.bytes());

		if (this.version.minor >= 33) {
			await this.readString();
		}

		if (this.version.minor >= 35) {
			await this.readInteger();
		}
	}

	private async setOptions(): Promise<void> {
		const request = new NixDaemonWriter();
		request.writeInteger(opSetOptions);

		// Nix worker-protocol 1.38 SetOptions fields, matching RemoteStore
		// and daemon ClientSettings order.
		request.writeBoolean(false);
		request.writeBoolean(false);
		request.writeBoolean(false);
		request.writeInteger(0);
		request.writeInteger(1);
		request.writeInteger(0);
		request.writeBoolean(true);
		request.writeInteger(0);
		request.writeInteger(0);
		request.writeInteger(0);
		request.writeInteger(0);
		request.writeBoolean(true);
		request.writeInteger(0);

		await this.transport.write(request.bytes());
		await this.processStderr();
	}

	private async queryUnkeyedPathInfo(
		storePath: string
	): Promise<UnkeyedDaemonPathInfo | undefined> {
		const request = new NixDaemonWriter();
		request.writeInteger(opQueryPathInfo);
		request.writeString(storePath);

		await this.transport.write(request.bytes());
		await this.processStderr();

		const valid = await this.readBoolean();

		if (!valid) {
			return undefined;
		}

		return this.readUnkeyedPathInfo();
	}

	private async readUnkeyedPathInfo(): Promise<UnkeyedDaemonPathInfo> {
		const deriver = emptyStringToUndefined(await this.readString());
		const narHash = nixDaemonHash(await this.readString());
		const references = await this.readStringSet();
		await this.readInteger();
		const narSize = await this.readInteger();
		await this.readBoolean();
		const signatures = await this.readStringSet();
		const ca = emptyStringToUndefined(await this.readString());

		return {
			deriver,
			narHash,
			references,
			narSize,
			ca,
			signatures
		};
	}

	private async processStderr(): Promise<void> {
		let hasMoreMessages = true;

		while (hasMoreMessages) {
			hasMoreMessages = await this.processNextStderrMessage();
		}
	}

	private async processNextStderrMessage(): Promise<boolean> {
		const messageType = await this.readInteger();

		if (messageType === stderrLast) {
			return false;
		}

		if (messageType === stderrWrite || messageType === stderrNext) {
			await this.readString();
			return true;
		}

		if (messageType === stderrRead) {
			throw new UnsupportedNixDaemonStderrReadError(await this.readInteger());
		}

		if (messageType === stderrError) {
			throw new NixDaemonRemoteError(await this.readErrorMessage());
		}

		if (messageType === stderrStartActivity) {
			await this.readInteger();
			await this.readInteger();
			await this.readInteger();
			await this.readString();
			await this.readLoggerFields();
			await this.readInteger();
			return true;
		}

		if (messageType === stderrStopActivity) {
			await this.readInteger();
			return true;
		}

		if (messageType === stderrResult) {
			await this.readInteger();
			await this.readInteger();
			await this.readLoggerFields();
			return true;
		}

		throw new UnknownNixDaemonStderrMessageError(messageType);
	}

	private async readErrorMessage(): Promise<string> {
		await this.readString();
		await this.readInteger();
		await this.readString();
		const message = await this.readString();
		await this.readInteger();
		const traceCount = await this.readInteger();

		for (let index = 0; index < traceCount; index += 1) {
			await this.readInteger();
			await this.readString();
		}

		return message;
	}

	private async readLoggerFields(): Promise<void> {
		const fieldCount = await this.readInteger();

		for (let index = 0; index < fieldCount; index += 1) {
			const fieldType = await this.readInteger();

			if (fieldType === 0) {
				await this.readInteger();
				continue;
			}

			await this.readString();
		}
	}

	private async readStringSet(): Promise<readonly string[]> {
		const count = await this.readInteger();
		const values: string[] = [];

		for (let index = 0; index < count; index += 1) {
			values.push(await this.readString());
		}

		return values;
	}

	private async readString(): Promise<string> {
		const length = await this.readInteger();
		const bytes =
			length === 0 ? new Uint8Array() : await this.transport.read(length);
		const padding = paddingLength(length);

		if (padding > 0) {
			await this.transport.read(padding);
		}

		const decoder = new TextDecoder();
		return decoder.decode(bytes);
	}

	private async readBoolean(): Promise<boolean> {
		return (await this.readInteger()) !== 0;
	}

	private async readInteger(): Promise<number> {
		const bytes = await this.transport.read(8);
		const value = Buffer.from(bytes).readBigUInt64LE();

		if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new NixDaemonRemoteError(
				`integer too large for JavaScript number: ${value.toString()}`
			);
		}

		return Number(value);
	}

	close(): void {
		this.transport.close();
	}

	async initialise(): Promise<void> {
		await this.handshake();
		await this.postHandshake();
		await this.processStderr();
		await this.setOptions();
	}

	async queryPathInfo(storePath: string): Promise<NixValidPathInfo> {
		const pathInfo = await this.queryUnkeyedPathInfo(storePath);

		if (pathInfo === undefined) {
			throw new NixStorePathNotFoundError(storePath);
		}

		return {
			storePath,
			narHash: pathInfo.narHash,
			narSize: pathInfo.narSize,
			references: pathInfo.references,
			deriver: pathInfo.deriver,
			ca: pathInfo.ca,
			signatures: pathInfo.signatures
		};
	}
}

class NixDaemonWriter {
	private readonly chunks: Buffer[] = [];

	writeInteger(value: number): void {
		const bytes = Buffer.alloc(8);
		bytes.writeBigUInt64LE(BigInt(value));
		this.chunks.push(bytes);
	}

	writeBoolean(value: boolean): void {
		this.writeInteger(value ? 1 : 0);
	}

	writeString(value: string): void {
		const bytes = Buffer.from(value, 'utf8');
		this.writeInteger(bytes.byteLength);
		this.chunks.push(bytes);

		const padding = paddingLength(bytes.byteLength);

		if (padding > 0) {
			this.chunks.push(Buffer.alloc(padding));
		}
	}

	writeStringSet(values: readonly string[]): void {
		this.writeInteger(values.length);

		for (const value of values) {
			this.writeString(value);
		}
	}

	bytes(): Buffer {
		return Buffer.concat(this.chunks);
	}
}

class SocketNixDaemonTransport implements NixDaemonTransport {
	private readonly reader: SocketReader;

	constructor(private readonly socket: Socket) {
		this.reader = new SocketReader(socket);
	}

	write(bytes: Uint8Array): Promise<void> {
		return new Promise((resolve, reject) => {
			// Node invokes the callback with null (not undefined) on success.
			this.socket.write(bytes, (error) => {
				if (error === undefined || error === null) {
					resolve();
					return;
				}

				reject(error);
			});
		});
	}

	read(byteLength: number): Promise<Uint8Array> {
		return this.reader.read(byteLength);
	}

	close(): void {
		this.socket.end();
	}
}

class SocketReader {
	private readonly chunks: Buffer[] = [];

	private bufferedBytes = 0;

	private pending?: PendingRead;

	private ended = false;

	private failure?: Error;

	constructor(socket: Socket) {
		socket.on('data', (chunk: Buffer) => {
			this.chunks.push(chunk);
			this.bufferedBytes += chunk.byteLength;
			this.resolvePendingRead();
		});
		socket.once('end', () => {
			this.ended = true;
			this.resolvePendingRead();
		});
		socket.once('error', (error) => {
			this.failure = error;
			this.resolvePendingRead();
		});
	}

	private resolvePendingRead(): void {
		if (this.pending === undefined) {
			return;
		}

		if (this.bufferedBytes >= this.pending.byteLength) {
			const pending = this.pending;
			this.pending = undefined;
			pending.resolve(this.consume(pending.byteLength));
			return;
		}

		if (this.failure !== undefined) {
			const pending = this.pending;
			this.pending = undefined;
			pending.reject(this.failure);
			return;
		}

		if (this.ended) {
			const pending = this.pending;
			this.pending = undefined;
			pending.reject(new NixDaemonRemoteError('daemon disconnected'));
		}
	}

	private consume(byteLength: number): Buffer {
		const result = Buffer.alloc(byteLength);
		let offset = 0;

		while (offset < byteLength) {
			const chunk = this.chunks[0];

			if (chunk === undefined) {
				throw new NixDaemonRemoteError('daemon read buffer underrun');
			}

			const available = Math.min(chunk.byteLength, byteLength - offset);
			chunk.copy(result, offset, 0, available);
			offset += available;
			this.bufferedBytes -= available;

			if (available === chunk.byteLength) {
				this.chunks.shift();
				continue;
			}

			this.chunks[0] = chunk.subarray(available);
		}

		return result;
	}

	read(byteLength: number): Promise<Uint8Array> {
		if (this.bufferedBytes >= byteLength) {
			return Promise.resolve(this.consume(byteLength));
		}

		if (this.failure !== undefined) {
			return Promise.reject(this.failure);
		}

		if (this.ended) {
			return Promise.reject(new NixDaemonRemoteError('daemon disconnected'));
		}

		return new Promise((resolve, reject) => {
			this.pending = { byteLength, resolve, reject };
		});
	}
}

interface PendingRead {
	readonly byteLength: number;
	resolve(bytes: Uint8Array): void;
	reject(error: Error): void;
}

async function resolveClosureWithConnection(
	connection: NixDaemonConnection,
	storePaths: readonly string[]
): Promise<readonly NixValidPathInfo[]> {
	const closure = new Map<string, NixValidPathInfo>();
	const pending = [...storePaths];

	while (pending.length > 0) {
		const storePath = pending.shift();

		if (storePath === undefined || closure.has(storePath)) {
			continue;
		}

		const pathInfo = await connection.queryPathInfo(storePath);
		closure.set(storePath, pathInfo);

		for (const reference of pathInfo.references) {
			if (!closure.has(reference)) {
				pending.push(reference);
			}
		}
	}

	const closureValues = closure.values();

	return [...closureValues].toSorted((left, right) =>
		left.storePath.localeCompare(right.storePath)
	);
}

function nixDaemonHash(base16Digest: string): NixSha256Hash {
	if (!/^[\da-f]{64}$/u.test(base16Digest)) {
		throw new InvalidNixDaemonHashError(base16Digest);
	}

	return NixSha256Hash.fromDigest(Buffer.from(base16Digest, 'hex'));
}

function versionToWire(version: NixDaemonProtocolVersion): number {
	return (version.major << 8) | version.minor;
}

function versionFromWire(wire: number): NixDaemonProtocolVersion {
	return {
		major: (wire & 0xff_00) >> 8,
		minor: wire & 0x00_ff
	};
}

function paddingLength(length: number): number {
	return (8 - (length % 8)) % 8;
}

function emptyStringToUndefined(value: string): string | undefined {
	return value === '' ? undefined : value;
}
