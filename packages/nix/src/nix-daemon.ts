import { createConnection, type Socket } from 'node:net';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import type { StorePathString } from '@cupboard/nix-store/scalars';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import {
	defaultClosureConcurrency,
	type NixDerivedPathString,
	type NixMissingPartition,
	type NixStoreClient,
	NixStorePathNotFoundError,
	type NixValidPathInfo,
	requireStorePath,
	resolveClosureBy
} from './nix-store.ts';
import type {
	NixDaemonOverrides,
	NixDaemonSetOptions
} from './store-config.ts';

const defaultDaemonSocketPath = '/nix/var/nix/daemon-socket/socket';
const workerMagic1 = 0x6e_69_78_63;
const workerMagic2 = 0x64_78_69_6f;
const protocolMajor = 1;
const protocolMinor = 38;
const minimumProtocolMinor = 38;

const opAddTemporaryRoot = 11;
const opSetOptions = 19;
const opQueryPathInfo = 26;
const opQueryValidPaths = 31;
const opQuerySubstitutablePaths = 32;
const opQueryMissing = 40;
const opQueryDerivationOutputMap = 41;

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
	readonly setOptions?: NixDaemonSetOptions;
	readonly overrides?: NixDaemonOverrides;
}

export type NixDaemonConnector = (
	socketPath: string
) => Promise<NixDaemonTransport>;

export interface NixDaemonTransport {
	write(bytes: Uint8Array): Promise<void>;
	read(byteLength: number): Promise<Uint8Array>;
	close(): Promise<void>;
}

/**
 * Whether the daemon trusts this client, as the handshake reports it:
 * `unknown` when the daemon leaves the flag unset.
 */
export type NixDaemonTrust = 'trusted' | 'not-trusted' | 'unknown';

/**
 * Operations bound to one open daemon connection. A temporary root taken
 * through the session lives exactly as long as that connection: the daemon
 * releases it when the connection closes, so the connection is the unit of
 * pinning and the session's queries see the store with those roots held.
 */
export interface NixDaemonSession {
	/**
	 * Protect a path from garbage collection for the life of this session's
	 * connection. There is no matching release; closing the connection is the
	 * release.
	 */
	addTempRoot(storePath: StorePathString): Promise<void>;
	queryPathInfo(storePath: StorePathString): Promise<NixValidPathInfo>;
	queryValidPaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]>;
	querySubstitutablePaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]>;
	queryMissing(
		targets: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition>;
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
	readonly ultimate: boolean;
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

// Raised when the pool shuts down while a query still needs a connection: an
// acquire after shutdown, a parked waiter, or a connection that finishes
// opening after the closure walk aborted. The abandoned query settles on a
// closed-pool error without using a dead socket.
export class NixDaemonConnectionPoolClosedError extends NixDaemonError {
	constructor() {
		super('Nix daemon connection pool closed during closure walk');
		this.name = 'NixDaemonConnectionPoolClosedError';
	}
}

export class NixDaemonStoreClient implements NixStoreClient {
	private readonly socketPath: string;

	private readonly connect: NixDaemonConnector;

	private readonly daemonSetOptions: NixDaemonSetOptions;

	private readonly overrides: NixDaemonOverrides;

	constructor(options: NixDaemonStoreClientOptions = {}) {
		this.socketPath = options.socketPath ?? defaultDaemonSocketPath;
		this.connect = options.connect ?? connectToNixDaemon;
		this.daemonSetOptions = options.setOptions ?? {};
		this.overrides = options.overrides ?? {};
	}

	private async openConnection(): Promise<NixDaemonConnection> {
		const transport = await this.connect(this.socketPath);
		const connection = new NixDaemonConnection(
			transport,
			this.daemonSetOptions,
			this.overrides
		);

		try {
			await connection.initialise();
		} catch (error) {
			await connection.close();
			throw error;
		}

		return connection;
	}

	async resolveClosure(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]> {
		const pool = new NixDaemonConnectionPool(
			() => this.openConnection(),
			defaultClosureConcurrency
		);

		try {
			return await resolveClosureBy(
				storePaths,
				(storePath) => pool.queryPathInfo(storePath),
				defaultClosureConcurrency
			);
		} finally {
			await pool.closeAll();
		}
	}

	async queryPathInfo(storePath: StorePathString): Promise<NixValidPathInfo> {
		return this.withConnection((session) => session.queryPathInfo(storePath));
	}

	async queryValidPaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]> {
		return this.withConnection((session) =>
			session.queryValidPaths(storePaths)
		);
	}

	async querySubstitutablePaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]> {
		return this.withConnection((session) =>
			session.querySubstitutablePaths(storePaths)
		);
	}

	async queryMissing(
		targets: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition> {
		if (targets.length === 0) {
			return emptyMissingPartition;
		}

		return this.withConnection((session) => session.queryMissing(targets));
	}

	/**
	 * Run `use` against a session bound to one daemon connection, closing the
	 * connection when `use` settles. A temporary root taken through the
	 * session is held by that connection alone, so the callback's extent
	 * decides exactly how long the roots protect their paths.
	 */
	async withConnection<T>(
		use: (session: NixDaemonSession) => Promise<T>
	): Promise<T> {
		const connection = await this.openConnection();

		try {
			return await use(new NixDaemonConnectionSession(connection));
		} finally {
			await connection.close();
		}
	}

	async queryDerivationOutputPaths(
		drvPaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]> {
		const candidates = sortedUnique(drvPaths);
		const pool = new NixDaemonConnectionPool(
			() => this.openConnection(),
			defaultClosureConcurrency
		);

		try {
			const outputPathGroups = await mapWithConcurrency(
				candidates,
				defaultClosureConcurrency,
				(drvPath) => pool.queryDerivationOutputPaths(drvPath)
			);

			return sortedUnique(outputPathGroups.flat());
		} finally {
			await pool.closeAll();
		}
	}

	/**
	 * Whether the daemon trusts this client. The daemon silently drops an
	 * untrusted client's setting overrides, so a caller that depends on a
	 * forwarded setting checks this before relying on it.
	 */
	async daemonTrust(): Promise<NixDaemonTrust> {
		const connection = await this.openConnection();

		try {
			return connection.trust;
		} finally {
			await connection.close();
		}
	}
}

const emptyMissingPartition: NixMissingPartition = {
	willBuild: [],
	willSubstitute: [],
	unknown: [],
	downloadSize: 0,
	narSize: 0
};

// The session over one connection: the semantic layer of the batched queries,
// deduplicating and sorting what goes on the wire and what comes back.
class NixDaemonConnectionSession implements NixDaemonSession {
	constructor(private readonly connection: NixDaemonConnection) {}

	addTempRoot(storePath: StorePathString): Promise<void> {
		return this.connection.addTempRoot(storePath);
	}

	queryPathInfo(storePath: StorePathString): Promise<NixValidPathInfo> {
		return this.connection.queryPathInfo(storePath);
	}

	async queryValidPaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]> {
		return sortedUnique(
			await this.connection.queryValidPaths(sortedUnique(storePaths))
		);
	}

	async querySubstitutablePaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]> {
		return sortedUnique(
			await this.connection.querySubstitutablePaths(sortedUnique(storePaths))
		);
	}

	async queryMissing(
		targets: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition> {
		const partition = await this.connection.queryMissing(sortedUnique(targets));

		return {
			willBuild: sortedUnique(partition.willBuild),
			willSubstitute: sortedUnique(partition.willSubstitute),
			unknown: sortedUnique(partition.unknown),
			downloadSize: partition.downloadSize,
			narSize: partition.narSize
		};
	}
}

// A lazily grown pool of daemon connections, each a serial request/response
// channel. The closure walk issues several queries at once; this hands each one
// a free connection, opens a new one up to the cap when none is free, and parks
// the query until one frees once the cap is reached. A small closure opens only
// as many connections as it has paths in flight; a large one fans out to the cap.
class NixDaemonConnectionPool {
	private readonly all: NixDaemonConnection[] = [];

	private readonly free: NixDaemonConnection[] = [];

	private readonly waiters: {
		readonly resolve: (connection: NixDaemonConnection) => void;
		readonly reject: (error: NixDaemonConnectionPoolClosedError) => void;
	}[] = [];

	private opened = 0;

	private closed = false;

	constructor(
		private readonly open: () => Promise<NixDaemonConnection>,
		private readonly max: number
	) {}

	private async acquire(): Promise<NixDaemonConnection> {
		if (this.closed) {
			throw new NixDaemonConnectionPoolClosedError();
		}

		const free = this.free.pop();

		if (free !== undefined) {
			return free;
		}

		if (this.opened < this.max) {
			this.opened += 1;

			let connection: NixDaemonConnection;

			try {
				connection = await this.open();
			} catch (error) {
				this.opened -= 1;
				throw error;
			}

			return this.registerOpened(connection);
		}

		return new Promise((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}

	private async registerOpened(
		connection: NixDaemonConnection
	): Promise<NixDaemonConnection> {
		// An opening connection is not yet in `all`, so shutdown may complete
		// while its asynchronous handshake is still in flight.
		if (this.closed) {
			await connection.close();
			throw new NixDaemonConnectionPoolClosedError();
		}

		this.all.push(connection);

		return connection;
	}

	private async release(connection: NixDaemonConnection): Promise<void> {
		if (this.closed) {
			await connection.close();
			return;
		}

		const waiter = this.waiters.shift();

		if (waiter !== undefined) {
			waiter.resolve(connection);

			return;
		}

		this.free.push(connection);
	}

	async queryPathInfo(storePath: StorePathString): Promise<NixValidPathInfo> {
		const connection = await this.acquire();

		try {
			return await connection.queryPathInfo(storePath);
		} finally {
			await this.release(connection);
		}
	}

	async queryDerivationOutputPaths(
		drvPath: StorePathString
	): Promise<readonly StorePathString[]> {
		const connection = await this.acquire();

		try {
			return await connection.queryDerivationOutputPaths(drvPath);
		} finally {
			await this.release(connection);
		}
	}

	async closeAll(): Promise<void> {
		this.closed = true;

		await Promise.all(this.all.map((connection) => connection.close()));

		const waiters = [...this.waiters];
		this.waiters.length = 0;

		for (const waiter of waiters) {
			waiter.reject(new NixDaemonConnectionPoolClosedError());
		}
	}
}

export async function connectToNixDaemon(
	socketPath: string
): Promise<NixDaemonTransport> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		const rejectConnection = (error: Error): void => {
			reject(new NixDaemonConnectionError(socketPath, error));
		};

		socket.once('connect', () => {
			socket.off('error', rejectConnection);
			resolve(new SocketNixDaemonTransport(socket));
		});
		socket.once('error', rejectConnection);
	});
}

class NixDaemonConnection {
	private version: NixDaemonProtocolVersion = {
		major: protocolMajor,
		minor: protocolMinor
	};

	private trustLevel: NixDaemonTrust = 'unknown';

	constructor(
		private readonly transport: NixDaemonTransport,
		private readonly options: NixDaemonSetOptions,
		private readonly overrides: NixDaemonOverrides
	) {}

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
			this.trustLevel = trustFromWire(await this.readInteger());
		}
	}

	private async setOptions(): Promise<void> {
		const request = new NixDaemonWriter();
		request.writeInteger(opSetOptions);

		// Nix worker-protocol 1.38 SetOptions fields, matching RemoteStore
		// and daemon ClientSettings order.
		request.writeBoolean(this.options.keepFailed ?? false);
		request.writeBoolean(this.options.keepGoing ?? false);
		request.writeBoolean(this.options.tryFallback ?? false);
		request.writeInteger(0);
		request.writeInteger(this.options.maxBuildJobs ?? 1);
		request.writeInteger(this.options.maxSilentTime ?? 0);
		request.writeBoolean(true);
		request.writeInteger(0);
		request.writeInteger(0);
		request.writeInteger(0);
		request.writeInteger(this.options.buildCores ?? 0);
		request.writeBoolean(this.options.useSubstitutes ?? true);

		const overrides = Object.entries(this.overrides).toSorted(
			([left], [right]) => left.localeCompare(right)
		);
		request.writeInteger(overrides.length);

		for (const [name, value] of overrides) {
			request.writeString(name);
			request.writeString(value);
		}

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

		const isValid = await this.readBoolean();

		if (!isValid) {
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
		const isUltimate = await this.readBoolean();
		const signatures = await this.readStringSet();
		const ca = emptyStringToUndefined(await this.readString());

		return {
			deriver,
			narHash,
			references,
			narSize,
			ca,
			signatures,
			ultimate: isUltimate
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

	private async readStorePathSet(): Promise<readonly StorePathString[]> {
		const paths = await this.readStringSet();

		return paths.map((path) => requireStorePath(path));
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

	get trust(): NixDaemonTrust {
		return this.trustLevel;
	}

	close(): Promise<void> {
		return this.transport.close();
	}

	async initialise(): Promise<void> {
		await this.handshake();
		await this.postHandshake();
		await this.processStderr();
		await this.setOptions();
	}

	async queryPathInfo(storePath: StorePathString): Promise<NixValidPathInfo> {
		const pathInfo = await this.queryUnkeyedPathInfo(storePath);

		if (pathInfo === undefined) {
			throw new NixStorePathNotFoundError(storePath);
		}

		return {
			storePath,
			narHash: pathInfo.narHash,
			narSize: pathInfo.narSize,
			references: pathInfo.references.map((reference) =>
				requireStorePath(reference)
			),
			deriver: pathInfo.deriver,
			ca: pathInfo.ca,
			signatures: pathInfo.signatures,
			ultimate: pathInfo.ultimate
		};
	}

	async queryValidPaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]> {
		const request = new NixDaemonWriter();
		request.writeInteger(opQueryValidPaths);
		request.writeStringSet(storePaths);
		// Whether the daemon may substitute the paths while answering; validity
		// is a read, so substitution stays off.
		request.writeBoolean(false);

		await this.transport.write(request.bytes());
		await this.processStderr();

		const validPaths = await this.readStringSet();

		return validPaths.map((path) => requireStorePath(path));
	}

	async querySubstitutablePaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]> {
		const request = new NixDaemonWriter();
		request.writeInteger(opQuerySubstitutablePaths);
		request.writeStringSet(storePaths);

		await this.transport.write(request.bytes());
		await this.processStderr();

		const substitutablePaths = await this.readStringSet();

		return substitutablePaths.map((path) => requireStorePath(path));
	}

	async addTempRoot(storePath: StorePathString): Promise<void> {
		const request = new NixDaemonWriter();
		request.writeInteger(opAddTemporaryRoot);
		request.writeString(storePath);

		await this.transport.write(request.bytes());
		await this.processStderr();
		// The reply carries one confirmation integer.
		await this.readInteger();
	}

	async queryMissing(
		targets: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition> {
		const request = new NixDaemonWriter();
		request.writeInteger(opQueryMissing);
		request.writeStringSet(targets.map((target) => legacyDerivedPath(target)));

		await this.transport.write(request.bytes());
		await this.processStderr();

		const buildPaths = await this.readStorePathSet();
		const substitutePaths = await this.readStorePathSet();
		const unknownPaths = await this.readStorePathSet();
		const downloadSize = await this.readInteger();
		const narSize = await this.readInteger();

		return {
			willBuild: buildPaths,
			willSubstitute: substitutePaths,
			unknown: unknownPaths,
			downloadSize,
			narSize
		};
	}

	async queryDerivationOutputPaths(
		drvPath: StorePathString
	): Promise<readonly StorePathString[]> {
		const request = new NixDaemonWriter();
		request.writeInteger(opQueryDerivationOutputMap);
		request.writeString(drvPath);

		await this.transport.write(request.bytes());
		await this.processStderr();

		const outputPaths: StorePathString[] = [];
		const count = await this.readInteger();

		// One (output name, store path) pair per entry; an unbuilt output has an
		// empty path.
		for (let index = 0; index < count; index += 1) {
			await this.readString();
			const outputPath = emptyStringToUndefined(await this.readString());

			if (outputPath !== undefined) {
				outputPaths.push(requireStorePath(outputPath));
			}
		}

		return outputPaths;
	}
}

class NixDaemonWriter {
	private readonly chunks: Buffer[] = [];

	writeInteger(value: number): void {
		const bytes = Buffer.alloc(8);
		bytes.writeBigUInt64LE(BigInt(value));
		this.chunks.push(bytes);
	}

	writeBoolean(isSet: boolean): void {
		this.writeInteger(isSet ? 1 : 0);
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

	private closePromise?: Promise<void>;

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

	close(): Promise<void> {
		if (this.closePromise !== undefined) {
			return this.closePromise;
		}

		if (this.socket.destroyed) {
			return Promise.resolve();
		}

		this.closePromise = new Promise((resolve) => {
			this.socket.once('close', resolve);
			this.socket.destroy();
		});

		return this.closePromise;
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
		socket.once('close', () => {
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

function nixDaemonHash(base16Digest: string): NixSha256Hash {
	if (!/^[\da-f]{64}$/u.test(base16Digest)) {
		throw new InvalidNixDaemonHashError(base16Digest);
	}

	return NixSha256Hash.fromDigest(Buffer.from(base16Digest, 'hex'));
}

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
	return [...new Set(values)].toSorted((left, right) =>
		left.localeCompare(right)
	);
}

// The wire spells a derived path in the legacy form, with `!` between the
// derivation and its outputs; the modern installable spelling uses `^`.
function legacyDerivedPath(target: NixDerivedPathString): string {
	const separator = target.indexOf('^');

	if (separator === -1) {
		return target;
	}

	return `${target.slice(0, separator)}!${target.slice(separator + 1)}`;
}

// Worker-protocol trust values: 1 trusted, 2 not trusted, 0 unset.
function trustFromWire(wire: number): NixDaemonTrust {
	if (wire === 1) {
		return 'trusted';
	}

	if (wire === 2) {
		return 'not-trusted';
	}

	return 'unknown';
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
