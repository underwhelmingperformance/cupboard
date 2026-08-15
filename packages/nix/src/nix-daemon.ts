import { createConnection, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type StoreDirectory,
	storeDirectorySchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

import { narRegularFileContents } from './nar-file.ts';
import {
	defaultClosureConcurrency,
	type NixBuildMode,
	type NixBuildOutcome,
	type NixBuildResult,
	type NixDaemonOffer,
	type NixDaemonTrust,
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
const defaultStoreDirectory = storeDirectorySchema.parse('/nix/store');
const workerMagic1 = 0x6e_69_78_63;
const workerMagic2 = 0x64_78_69_6f;
const protocolMajor = 1;
const protocolMinor = 38;
const minimumProtocolMinor = 38;

const opAddTemporaryRoot = 11;
const opSetOptions = 19;
const opQueryPathInfo = 26;
const opQuerySubstitutablePathInfos = 30;
const opQueryValidPaths = 31;
const opQuerySubstitutablePaths = 32;
const opNarFromPath = 38;
const opQueryMissing = 40;
const opQueryDerivationOutputMap = 41;
const opQueryPathInfos = 50;
const opBuildPathsWithResults = 46;

const buildModeNormal = 0;
const buildModeCheck = 2;

function buildModeWireValue(mode: NixBuildMode): number {
	return mode === 'check' ? buildModeCheck : buildModeNormal;
}

// The keyed results encoding exists from worker protocol 1.34; the handshake
// already refuses daemons below 1.38, so this bound documents the operation's
// own requirement.
const minimumBuildResultsMinor = 34;

// From worker protocol 1.22 the substitutable-info request carries a map from
// store path to the content address to look it up under; below that it is a
// plain path set. The handshake already refuses daemons below 1.38, so this
// bound documents the request encoding's own requirement.
const minimumSubstitutablePathInfosMinor = 22;

// BuildResult::Status wire values in declaration order; `cached-failure` is
// reserved by the protocol.
const buildStatusKinds = [
	'built',
	'substituted',
	'already-valid',
	'permanent-failure',
	'input-rejected',
	'output-rejected',
	'transient-failure',
	'cached-failure',
	'timed-out',
	'misc-failure',
	'dependency-failed',
	'log-limit-exceeded',
	'not-deterministic',
	'resolves-to-already-valid',
	'no-substituters'
] as const;

// The NAR grammar's fixed words are all at most as long as its magic; a
// structural token above that length is malformed.
const maxNarWordLength = 'nix-archive-1'.length;
const narChunkSize = 64 * 1024;
const maximumDaemonScalarBytes = 1024 * 1024;
const maximumDaemonCollectionEntries = 100_000;
const maximumDaemonFeatures = 4096;
const maximumDaemonLoggerFields = 4096;
const maximumDaemonTraceEntries = 4096;
const maximumDaemonDerivationOutputs = 65_536;

// Offered during the handshake; a daemon that advertises it back accepts the
// batched path-info operation. No released daemon does yet, so the batch is
// speculative, and this client falls back to the per-path operation with
// current daemons.
const featureQueryPathInfos = 'queryPathInfos';

const stderrNext = 0x6f_6c_6d_67;
const stderrRead = 0x64_61_74_61;
const stderrWrite = 0x64_61_74_16;
const stderrLast = 0x61_6c_74_73;
const stderrError = 0x63_78_74_70;
const stderrStartActivity = 0x53_54_52_54;
const stderrStopActivity = 0x53_54_4f_50;
const stderrResult = 0x52_53_4c_54;

interface NixDaemonStoreClientConnectionOptions {
	readonly socketPath?: string;
	readonly connect?: NixDaemonConnector;
	readonly storeDirectory?: StoreDirectory;
	readonly maxConnections?: number;
	readonly maxConnectionAge?: number;
	readonly signal?: AbortSignal;
}

/** How a daemon client configures a connection after its handshake. */
export type NixDaemonStoreClientOptions =
	NixDaemonStoreClientConnectionOptions &
		(
			| {
					/** Preserve the daemon's settings by omitting SetOptions. */
					readonly shouldPreserveDaemonOptions: true;
					readonly setOptions?: never;
					readonly overrides?: never;
			  }
			| {
					readonly shouldPreserveDaemonOptions?: false;
					readonly setOptions?: NixDaemonSetOptions;
					readonly overrides?: NixDaemonOverrides;
			  }
		);

export type NixDaemonConnector = (
	socketPath: string,
	signal?: AbortSignal
) => Promise<NixDaemonTransport>;

export interface NixDaemonTransport {
	write(bytes: Uint8Array): Promise<void>;
	read(byteLength: number): Promise<Uint8Array>;
	close(): Promise<void>;
}

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
	/** Build targets on this session's connection, returning keyed outcomes. */
	buildPathsWithResults(
		targets: readonly NixDerivedPathString[],
		mode?: NixBuildMode
	): Promise<readonly NixBuildResult[]>;
	/** Read one derivation through this session's selected store. */
	readDerivation(drvPath: StorePathString): Promise<string>;
	/** Resolve path metadata for a closure on this session's connection. */
	resolveClosure(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]>;
	queryPathInfo(storePath: StorePathString): Promise<NixValidPathInfo>;
	queryValidPaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]>;
	querySubstitutablePaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]>;
	querySubstitutablePathInfos(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixDaemonOffer[]>;
	queryMissing(
		targets: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition>;
	/**
	 * The NAR serialisation of the given path, streamed over this session's
	 * connection. The stream must be drained before the session issues its
	 * next operation: the connection is a serial request/response channel.
	 */
	narFromPath(storePath: StorePathString): AsyncIterable<Uint8Array>;
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

export class InvalidNixDaemonNarError extends NixDaemonError {
	constructor(public readonly reason: string) {
		super(`The daemon sent bytes that do not form a NAR: ${reason}`);
		this.name = 'InvalidNixDaemonNarError';
	}
}

export class NixDaemonFieldTooLargeError extends NixDaemonError {
	constructor(
		public readonly field: string,
		public readonly maximumBytes: number,
		public readonly observedBytes: number
	) {
		super(
			`Nix daemon ${field} is too large: received ${String(observedBytes)} bytes, maximum ${String(maximumBytes)}`
		);
		this.name = 'NixDaemonFieldTooLargeError';
	}
}

export class NixDaemonCollectionTooLargeError extends NixDaemonError {
	constructor(
		public readonly collection: string,
		public readonly maximumEntries: number,
		public readonly observedEntries: number
	) {
		super(
			`Nix daemon ${collection} has too many entries: received ${String(observedEntries)}, maximum ${String(maximumEntries)}`
		);
		this.name = 'NixDaemonCollectionTooLargeError';
	}
}

export class UnsupportedNixDaemonOperationError extends NixDaemonError {
	constructor(
		public readonly operation: string,
		public readonly version: NixDaemonProtocolVersion
	) {
		super(
			`The daemon's protocol ${String(version.major)}.${String(version.minor)} does not support ${operation}`
		);
		this.name = 'UnsupportedNixDaemonOperationError';
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

function combinedAbortSignal(
	first: AbortSignal | undefined,
	second: AbortSignal | undefined
): AbortSignal | undefined {
	if (first === undefined || first === second) {
		return second;
	}

	if (second === undefined) {
		return first;
	}

	return AbortSignal.any([first, second]);
}

export class NixDaemonStoreClient implements NixStoreClient {
	private readonly socketPath: string;

	private readonly connect: NixDaemonConnector;

	private readonly maxConnections: number;

	private readonly maxConnectionAge?: number;

	private readonly storeDirectory: StoreDirectory;

	private readonly connectionBudget: NixDaemonConnectionBudget;

	private readonly daemonSetOptions: NixDaemonSetOptions;

	private readonly overrides: NixDaemonOverrides;

	private readonly signal?: AbortSignal;

	/** Whether this client deliberately omits SetOptions on every connection. */
	readonly preservesDaemonOptions: boolean;

	constructor(options: NixDaemonStoreClientOptions = {}) {
		this.socketPath = options.socketPath ?? defaultDaemonSocketPath;
		this.connect = options.connect ?? connectToNixDaemon;
		this.preservesDaemonOptions = options.shouldPreserveDaemonOptions ?? false;
		this.maxConnections = Math.max(
			1,
			options.maxConnections ?? defaultClosureConcurrency
		);
		this.maxConnectionAge = options.maxConnectionAge;
		this.storeDirectory = options.storeDirectory ?? defaultStoreDirectory;
		this.connectionBudget = new NixDaemonConnectionBudget(this.maxConnections);
		this.daemonSetOptions = options.setOptions ?? {};
		this.overrides = options.overrides ?? {};
		this.signal = options.signal;
	}

	private async openConnection(
		operationSignal?: AbortSignal
	): Promise<NixDaemonConnection> {
		const signal = combinedAbortSignal(this.signal, operationSignal);
		signal?.throwIfAborted();
		const release = await this.connectionBudget.acquire(signal);
		const openedAt = performance.now();
		let connected: Promise<NixDaemonTransport>;

		try {
			connected = this.connect(this.socketPath, signal);
		} catch (error) {
			release();
			throw error;
		}

		let transport: NixDaemonTransport;

		try {
			transport = await waitForTransport(connected, signal);
		} catch (error) {
			void closeTransportWhenConnected(connected).finally(release);
			throw error;
		}

		const abortableTransport =
			signal === undefined
				? transport
				: new AbortableNixDaemonTransport(transport, signal);
		const connection = new NixDaemonConnection(
			abortableTransport,
			this.preservesDaemonOptions,
			this.daemonSetOptions,
			this.overrides,
			this.storeDirectory,
			openedAt,
			release,
			signal
		);

		try {
			await connection.initialise();
		} catch (error) {
			await connection.close();
			throw error;
		}

		return connection;
	}

	private connectionPool(
		initialConnection?: NixDaemonConnection
	): NixDaemonConnectionPool {
		return new NixDaemonConnectionPool(
			(signal) => this.openConnection(signal),
			this.maxConnections,
			initialConnection,
			(connection) =>
				this.maxConnectionAge === undefined ||
				connection.ageAt(performance.now()) < this.maxConnectionAge
		);
	}

	private async cancelPoolOnFailure<T>(
		pool: NixDaemonConnectionPool,
		operation: () => Promise<T>
	): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			pool.cancelPendingQueries();
			throw error;
		}
	}

	// One connection decides how a whole batch is answered: its handshake
	// negotiated whether the daemon accepts the batched operation. A batch
	// answer closes that connection; a fallback hands it on as the pool's
	// first connection so the handshake round trip is not paid twice.
	private async queryPathsInfoBatch(
		storePaths: readonly StorePathString[]
	): Promise<
		| { readonly kind: 'batch'; readonly infos: readonly NixValidPathInfo[] }
		| { readonly kind: 'fallback'; readonly connection: NixDaemonConnection }
	> {
		if (storePaths.length === 0) {
			return { kind: 'batch', infos: [] };
		}

		const connection = await this.openConnection();

		if (!connection.supportsQueryPathInfos) {
			return { kind: 'fallback', connection };
		}

		try {
			return {
				kind: 'batch',
				infos: await connection.queryPathsInfo(sortedUnique(storePaths))
			};
		} finally {
			await connection.close();
		}
	}

	private async queryPathsInfoBy<T>(
		storePaths: readonly StorePathString[],
		query: (
			storePath: StorePathString,
			pool: NixDaemonConnectionPool
		) => Promise<T>,
		initialConnection: NixDaemonConnection
	): Promise<readonly T[]> {
		const pool = this.connectionPool(initialConnection);

		try {
			return await mapWithConcurrency(
				storePaths,
				this.maxConnections,
				(storePath) =>
					this.cancelPoolOnFailure(pool, () => query(storePath, pool))
			);
		} finally {
			await pool.closeAll();
		}
	}

	async resolveClosure(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]> {
		const pool = this.connectionPool();

		try {
			return await resolveClosureBy(
				storePaths,
				(storePath) =>
					this.cancelPoolOnFailure(pool, () => pool.queryPathInfo(storePath)),
				this.maxConnections
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

	async querySubstitutablePathInfos(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixDaemonOffer[]> {
		if (storePaths.length === 0) {
			return [];
		}

		return this.withConnection((session) =>
			session.querySubstitutablePathInfos(storePaths)
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
	 * The derivation's text, extracted from the single regular file its NAR
	 * serialises. The worker protocol reaches store contents only as NARs, so
	 * the derivation arrives wrapped in one.
	 */
	async readDerivation(drvPath: StorePathString): Promise<string> {
		return new TextDecoder().decode(
			await narRegularFileContents(this.narFromPath(drvPath))
		);
	}

	/**
	 * The NAR serialisation of the given path, streamed over a connection
	 * dedicated to this stream and closed when it settles: on a full drain,
	 * on an error, and when the consumer stops early.
	 */
	async *narFromPath(storePath: StorePathString): AsyncIterable<Uint8Array> {
		const connection = await this.openConnection();

		try {
			yield* connection.narFromPath(storePath);
		} finally {
			await connection.close();
		}
	}

	/**
	 * Build the given targets and report the outcome of each one, with the
	 * realised outputs where the daemon reports them. A caller reconciling a
	 * remote store reads those outputs after a build.
	 */
	async buildPathsWithResults(
		targets: readonly NixDerivedPathString[],
		mode: NixBuildMode = 'normal'
	): Promise<readonly NixBuildResult[]> {
		if (targets.length === 0) {
			return [];
		}

		const connection = await this.openConnection();

		try {
			return await connection.buildPathsWithResults(
				sortedUnique(targets),
				mode
			);
		} finally {
			await connection.close();
		}
	}

	async queryPathsInfo(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]> {
		const batch = await this.queryPathsInfoBatch(storePaths);

		if (batch.kind === 'batch') {
			const infos = new Map(batch.infos.map((info) => [info.storePath, info]));

			return storePaths.map((storePath) => {
				const info = infos.get(storePath);

				if (info === undefined) {
					throw new NixStorePathNotFoundError(storePath);
				}

				return info;
			});
		}

		return this.queryPathsInfoBy(
			storePaths,
			(storePath, pool) => pool.queryPathInfo(storePath),
			batch.connection
		);
	}

	async queryValidPathsInfo(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]> {
		const batch = await this.queryPathsInfoBatch(storePaths);

		if (batch.kind === 'batch') {
			const infos = new Map(batch.infos.map((info) => [info.storePath, info]));

			return storePaths.flatMap((storePath) => {
				const info = infos.get(storePath);

				return info === undefined ? [] : [info];
			});
		}

		const infos = await this.queryPathsInfoBy(
			storePaths,
			async (storePath, pool) => {
				try {
					return await pool.queryPathInfo(storePath);
				} catch (error) {
					if (error instanceof NixStorePathNotFoundError) {
						return;
					}

					throw error;
				}
			},
			batch.connection
		);

		return infos.filter((info) => info !== undefined);
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
			const operation = use(new NixDaemonConnectionSession(connection));

			if (this.signal === undefined) {
				return await operation;
			}

			return await runWithSignal(operation, this.signal, () => {
				void connection.close();
			});
		} finally {
			await connection.close();
		}
	}

	async queryDerivationOutputPaths(
		drvPaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]> {
		const candidates = sortedUnique(drvPaths);
		const pool = this.connectionPool();

		try {
			const outputPathGroups = await mapWithConcurrency(
				candidates,
				this.maxConnections,
				(drvPath) =>
					this.cancelPoolOnFailure(pool, () =>
						pool.queryDerivationOutputPaths(drvPath)
					)
			);

			return sortedUnique(outputPathGroups.flat());
		} finally {
			await pool.closeAll();
		}
	}

	/**
	 * Whether the daemon trusts this client. The daemon silently drops an
	 * untrusted client's setting overrides, so a caller that depends on a
	 * forwarded setting checks the trust level first.
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

interface NixDaemonConnectionLease {
	release(): void;
}

// The session over one connection: the semantic layer of the batched queries,
// deduplicating and sorting what goes on the wire and what comes back. The
// worker protocol is a serial request/response stream, so public operations
// queue for exclusive ownership of the connection.
class NixDaemonConnectionSession implements NixDaemonSession {
	private operationTail = Promise.resolve();

	constructor(private readonly connection: NixDaemonConnection) {}

	private async acquireConnection(): Promise<NixDaemonConnectionLease> {
		const preceding = this.operationTail;
		const operation = Promise.withResolvers<undefined>();
		this.operationTail = operation.promise;

		await preceding;

		return {
			release() {
				operation.resolve(undefined);
			}
		};
	}

	private async run<T>(operation: () => Promise<T>): Promise<T> {
		const release = await this.acquireConnection();

		try {
			return await operation();
		} finally {
			release.release();
		}
	}

	addTempRoot(storePath: StorePathString): Promise<void> {
		return this.run(() => this.connection.addTempRoot(storePath));
	}

	buildPathsWithResults(
		targets: readonly NixDerivedPathString[],
		mode: NixBuildMode = 'normal'
	): Promise<readonly NixBuildResult[]> {
		return this.run(() =>
			this.connection.buildPathsWithResults(sortedUnique(targets), mode)
		);
	}

	readDerivation(drvPath: StorePathString): Promise<string> {
		return this.run(() => this.connection.readDerivation(drvPath));
	}

	resolveClosure(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]> {
		return this.run(() =>
			resolveClosureBy(storePaths, (storePath) =>
				this.connection.queryPathInfo(storePath)
			)
		);
	}

	queryPathInfo(storePath: StorePathString): Promise<NixValidPathInfo> {
		return this.run(() => this.connection.queryPathInfo(storePath));
	}

	queryValidPaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]> {
		return this.run(async () =>
			sortedUnique(
				await this.connection.queryValidPaths(sortedUnique(storePaths))
			)
		);
	}

	querySubstitutablePaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]> {
		return this.run(async () =>
			sortedUnique(
				await this.connection.querySubstitutablePaths(sortedUnique(storePaths))
			)
		);
	}

	querySubstitutablePathInfos(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixDaemonOffer[]> {
		return this.run(async () => {
			const infos = await this.connection.querySubstitutablePathInfos(
				sortedUnique(storePaths)
			);

			return infos.toSorted((left, right) =>
				byCodeUnit(left.storePath, right.storePath)
			);
		});
	}

	queryMissing(
		targets: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition> {
		return this.run(async () => {
			const partition = await this.connection.queryMissing(
				sortedUnique(targets)
			);

			return {
				willBuild: sortedUnique(partition.willBuild),
				willSubstitute: sortedUnique(partition.willSubstitute),
				unknown: sortedUnique(partition.unknown),
				downloadSize: partition.downloadSize,
				narSize: partition.narSize
			};
		});
	}

	async *narFromPath(storePath: StorePathString): AsyncIterable<Uint8Array> {
		const release = await this.acquireConnection();

		try {
			yield* this.connection.narFromPath(storePath);
		} finally {
			release.release();
		}
	}
}

interface NixDaemonConnectionBudgetWaiter {
	readonly signal?: AbortSignal;
	readonly resolve: (release: () => void) => void;
	readonly reject: (error: unknown) => void;
	readonly abort: () => void;
}

// Every operation ultimately opens through this client-owned budget. Pools
// still decide which of their connections to reuse, while the budget makes the
// store URI's limit apply across pools, sessions, builds, and streaming reads.
class NixDaemonConnectionBudget {
	private active = 0;

	private readonly waiters: NixDaemonConnectionBudgetWaiter[] = [];

	constructor(private readonly max: number) {}

	private lease(): () => void {
		let isReleased = false;

		return () => {
			if (isReleased) {
				return;
			}

			isReleased = true;
			this.release();
		};
	}

	private release(): void {
		let waiter = this.waiters.shift();

		while (waiter !== undefined) {
			waiter.signal?.removeEventListener('abort', waiter.abort);

			if (waiter.signal?.aborted === true) {
				waiter.reject(abortReason(waiter.signal));
				waiter = this.waiters.shift();
				continue;
			}

			waiter.resolve(this.lease());
			return;
		}

		this.active -= 1;
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		signal?.throwIfAborted();

		if (this.active < this.max) {
			this.active += 1;

			return this.lease();
		}

		return new Promise((resolve, reject) => {
			const abort = (): void => {
				const index = this.waiters.indexOf(waiter);

				if (index === -1 || signal === undefined) {
					return;
				}

				this.waiters.splice(index, 1);
				reject(abortReason(signal));
			};
			const waiter: NixDaemonConnectionBudgetWaiter = {
				signal,
				resolve,
				reject,
				abort
			};
			this.waiters.push(waiter);
			signal?.addEventListener('abort', abort, { once: true });
		});
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error('The Nix daemon operation was aborted', {
				cause: signal.reason
			});
}

// A lazily grown pool of daemon connections, each a serial request/response
// channel. The closure walk issues several queries at once. The pool gives each
// query a free connection, opens a new connection up to the cap when none is
// free, and, once the cap is reached, makes the query wait for a connection to
// be released. A small closure opens only as many connections as it has paths
// in flight; a large one fans out to the cap.
class NixDaemonConnectionPool {
	private readonly all: NixDaemonConnection[] = [];

	private readonly free: NixDaemonConnection[] = [];

	private readonly waiters: {
		readonly resolve: (connection: NixDaemonConnection) => void;
		readonly reject: (error: unknown) => void;
	}[] = [];

	private opened = 0;

	private closed = false;

	private readonly shutdown = new AbortController();

	private readonly opening = new Set<Promise<NixDaemonConnection>>();

	constructor(
		private readonly open: (
			signal: AbortSignal
		) => Promise<NixDaemonConnection>,
		private readonly max: number,
		initialConnection?: NixDaemonConnection,
		private readonly isReusable: (
			connection: NixDaemonConnection
		) => boolean = () => true
	) {
		if (initialConnection === undefined) {
			return;
		}

		this.all.push(initialConnection);
		this.free.push(initialConnection);
		this.opened = 1;
	}

	private async acquire(): Promise<NixDaemonConnection> {
		if (this.closed) {
			throw new NixDaemonConnectionPoolClosedError();
		}

		let free = this.free.pop();

		while (free !== undefined) {
			if (this.isReusable(free)) {
				return free;
			}

			await this.retire(free);
			free = this.free.pop();
		}

		if (this.opened < this.max) {
			this.opened += 1;
			const opening = this.openAndRegister();
			this.opening.add(opening);

			try {
				return await opening;
			} catch (error) {
				this.opened -= 1;
				throw error;
			} finally {
				this.opening.delete(opening);
			}
		}

		return new Promise((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}

	private async openAndRegister(): Promise<NixDaemonConnection> {
		const connection = await this.open(this.shutdown.signal);

		return this.registerOpened(connection);
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
			this.free.push(connection);
			void this.serve(waiter);

			return;
		}

		this.free.push(connection);
	}

	private async serve(waiter: {
		readonly resolve: (connection: NixDaemonConnection) => void;
		readonly reject: (error: unknown) => void;
	}): Promise<void> {
		try {
			waiter.resolve(await this.acquire());
		} catch (error) {
			waiter.reject(error);
		}
	}

	private async retire(connection: NixDaemonConnection): Promise<void> {
		const index = this.all.indexOf(connection);

		if (index !== -1) {
			this.all.splice(index, 1);
			this.opened -= 1;
		}

		await connection.close();
	}

	cancelPendingQueries(): void {
		if (this.closed) {
			return;
		}

		this.closed = true;
		this.shutdown.abort(new NixDaemonConnectionPoolClosedError());

		// Connections already registered with the pool may not carry the
		// shutdown signal: the feature-probing connection is opened before the
		// fallback pool exists and then reused by it. Closing every registered
		// connection makes cancellation reach those in-flight operations too.
		for (const connection of this.all) {
			void connection.close();
		}

		const waiters = [...this.waiters];
		this.waiters.length = 0;

		for (const waiter of waiters) {
			waiter.reject(new NixDaemonConnectionPoolClosedError());
		}
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
		this.cancelPendingQueries();

		await Promise.all([
			Promise.all(this.all.map((connection) => connection.close())),
			Promise.allSettled(this.opening)
		]);
	}
}

export async function connectToNixDaemon(
	socketPath: string,
	signal?: AbortSignal
): Promise<NixDaemonTransport> {
	signal?.throwIfAborted();

	const socket = createConnection(socketPath);
	const connected = new Promise<NixDaemonTransport>((resolve, reject) => {
		const cleanUp = (): void => {
			socket.off('error', rejectConnection);
		};
		const rejectConnection = (error: Error): void => {
			cleanUp();
			reject(new NixDaemonConnectionError(socketPath, error));
		};

		socket.once('connect', () => {
			cleanUp();
			resolve(new SocketNixDaemonTransport(socket));
		});
		socket.once('error', rejectConnection);
	});

	return signal === undefined
		? connected
		: runWithSignal(connected, signal, () => {
				socket.destroy();
			});
}

async function waitForTransport(
	connected: Promise<NixDaemonTransport>,
	signal?: AbortSignal
): Promise<NixDaemonTransport> {
	if (signal === undefined) {
		return connected;
	}

	signal.throwIfAborted();

	return runWithSignal(connected, signal, () => {
		signal.throwIfAborted();
	});
}

async function closeTransportWhenConnected(
	connected: Promise<NixDaemonTransport>
): Promise<void> {
	try {
		const transport = await connected;
		await transport.close();
	} catch {
		// The failed connection has no transport to close.
	}
}

interface AbortOutcome {
	readonly promise: Promise<{ readonly kind: 'aborted' }>;
	removeListener(): void;
}

function abortOutcome(signal: AbortSignal): AbortOutcome {
	let listener: () => void;
	const abort = new Promise<{ readonly kind: 'aborted' }>((resolve) => {
		listener = () => {
			resolve({ kind: 'aborted' });
		};
		signal.addEventListener('abort', listener, { once: true });
	});

	return {
		promise: abort,
		removeListener: () => {
			signal.removeEventListener('abort', listener);
		}
	};
}

async function completed<T>(
	operation: Promise<T>
): Promise<{ readonly kind: 'completed'; readonly value: T }> {
	return { kind: 'completed', value: await operation };
}

async function runWithSignal<T>(
	operation: Promise<T>,
	signal: AbortSignal,
	onAbort: () => void
): Promise<T> {
	signal.throwIfAborted();

	const aborted = abortOutcome(signal);
	let outcome:
		| { readonly kind: 'completed'; readonly value: T }
		| { readonly kind: 'aborted' };

	try {
		outcome = await Promise.race([completed(operation), aborted.promise]);
	} finally {
		aborted.removeListener();
	}

	if (outcome.kind === 'completed') {
		return outcome.value;
	}

	onAbort();
	signal.throwIfAborted();

	throw new Error('Abort signal settled without being aborted');
}

class AbortableNixDaemonTransport implements NixDaemonTransport {
	private closePromise?: Promise<void>;

	constructor(
		private readonly transport: NixDaemonTransport,
		private readonly signal: AbortSignal
	) {}

	private async run<T>(operation: () => Promise<T>): Promise<T> {
		this.signal.throwIfAborted();

		return runWithSignal(operation(), this.signal, () => {
			void this.close();
		});
	}

	write(bytes: Uint8Array): Promise<void> {
		return this.run(() => this.transport.write(bytes));
	}

	read(byteLength: number): Promise<Uint8Array> {
		return this.run(() => this.transport.read(byteLength));
	}

	close(): Promise<void> {
		this.closePromise ??= this.transport.close();

		return this.closePromise;
	}
}

class NixDaemonConnection {
	private closePromise?: Promise<void>;

	private readonly abortListener?: () => void;

	private version: NixDaemonProtocolVersion = {
		major: protocolMajor,
		minor: protocolMinor
	};

	private trustLevel: NixDaemonTrust = 'unknown';

	private readonly features = new Set<string>();

	constructor(
		private readonly transport: NixDaemonTransport,
		private readonly shouldPreserveDaemonOptions: boolean,
		private readonly options: NixDaemonSetOptions,
		private readonly overrides: NixDaemonOverrides,
		private readonly storeDirectory: StoreDirectory,
		private readonly openedAt: number,
		private readonly releaseBudget: () => void,
		private readonly signal?: AbortSignal
	) {
		if (signal === undefined) {
			return;
		}

		this.abortListener = () => {
			void this.close();
		};
		signal.addEventListener('abort', this.abortListener, { once: true });

		if (signal.aborted) {
			this.abortListener();
		}
	}

	private async closeTransport(): Promise<void> {
		if (this.abortListener !== undefined) {
			this.signal?.removeEventListener('abort', this.abortListener);
		}

		try {
			await this.transport.close();
		} finally {
			this.releaseBudget();
		}
	}

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
		features.writeStringSet([featureQueryPathInfos]);

		await this.transport.write(features.bytes());
		const daemonFeatures = await this.readStringSet(
			'daemon features',
			maximumDaemonFeatures
		);

		if (daemonFeatures.includes(featureQueryPathInfos)) {
			this.features.add(featureQueryPathInfos);
		}
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
			await this.readString('daemon version');
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
		const deriver = emptyStringToUndefined(
			await this.readString('path info deriver')
		);
		const narHash = nixDaemonHash(await this.readString('path info NAR hash'));
		const references = await this.readStringSet('path info references');
		await this.readInteger();
		const narSize = await this.readInteger();
		const isUltimate = await this.readBoolean();
		const signatures = await this.readStringSet('path info signatures');
		const ca = emptyStringToUndefined(
			await this.readString('path info content address')
		);

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
			await this.readString('daemon log message');
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
			await this.readString('activity message');
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
		await this.readString('error type');
		await this.readInteger();
		await this.readString('error name');
		const message = await this.readString('error message');
		await this.readInteger();
		const traceCount = await this.readCount(
			'error traces',
			maximumDaemonTraceEntries
		);

		for (let index = 0; index < traceCount; index += 1) {
			await this.readInteger();
			await this.readString('error trace');
		}

		return message;
	}

	private async readLoggerFields(): Promise<void> {
		const fieldCount = await this.readCount(
			'logger fields',
			maximumDaemonLoggerFields
		);

		for (let index = 0; index < fieldCount; index += 1) {
			const fieldType = await this.readInteger();

			if (fieldType === 0) {
				await this.readInteger();
				continue;
			}

			await this.readString('logger field');
		}
	}

	private async readStringSet(
		collection: string,
		maximumEntries = maximumDaemonCollectionEntries
	): Promise<readonly string[]> {
		const count = await this.readCount(collection, maximumEntries);
		const values: string[] = [];

		for (let index = 0; index < count; index += 1) {
			values.push(await this.readString(`${collection} entry`));
		}

		return values;
	}

	private async readStorePathSet(
		collection: string,
		maximumEntries = maximumDaemonCollectionEntries
	): Promise<readonly StorePathString[]> {
		const paths = await this.readStringSet(collection, maximumEntries);

		return paths.map((path) => requireStorePath(path));
	}

	// One keyed build result at protocol 1.38: the derived path, the status
	// and message, the 1.29 timing fields, the 1.37 optional cpu times, and
	// the built outputs map of realisations.
	private async readKeyedBuildResult(): Promise<NixBuildResult> {
		const target = modernDerivedPath(
			await this.readString('build result target')
		);
		const status = await this.readInteger();
		const message = await this.readString('build result message');
		const timesBuilt = await this.readInteger();
		const isNonDeterministic = await this.readBoolean();
		const startTime = await this.readInteger();
		const stopTime = await this.readInteger();
		await this.readOptionalInteger();
		await this.readOptionalInteger();
		const outputs = await this.readBuiltOutputs();

		return {
			target,
			outcome: buildOutcome(status, message, outputs),
			timesBuilt,
			nonDeterministic: isNonDeterministic,
			startTime,
			stopTime
		};
	}

	private async readOptionalInteger(): Promise<number | undefined> {
		const isPresent = await this.readBoolean();

		return isPresent ? this.readInteger() : undefined;
	}

	// The built outputs arrive as a map of derivation output ids
	// (`<drvhash>!<name>`) to realisations serialised as JSON; the output
	// name and the realised store path are what a build outcome carries.
	private async readBuiltOutputs(): Promise<Record<string, StorePathString>> {
		const count = await this.readCount(
			'derivation outputs',
			maximumDaemonDerivationOutputs
		);
		const outputs: [string, StorePathString][] = [];
		const outputNames = new Set<string>();

		for (let index = 0; index < count; index += 1) {
			const id = await this.readString('derivation output id');
			const realisation = await this.readString(
				'derivation output realisation'
			);
			const outputName = outputNameFromDrvOutputId(id);

			if (outputNames.has(outputName)) {
				throw new NixDaemonRemoteError(
					`keyed build result contains duplicate output name: ${outputName}`
				);
			}

			const outputPath = realisationOutputPath(
				realisation,
				this.storeDirectory
			);

			outputNames.add(outputName);
			outputs.push([outputName, outputPath]);
		}

		return Object.fromEntries(outputs);
	}

	private async readCount(
		collection: string,
		maximumEntries: number
	): Promise<number> {
		const observedEntries = await this.readInteger();

		if (observedEntries > maximumEntries) {
			throw new NixDaemonCollectionTooLargeError(
				collection,
				maximumEntries,
				observedEntries
			);
		}

		return observedEntries;
	}

	private async readString(field: string): Promise<string> {
		const length = await this.readInteger();

		if (length > maximumDaemonScalarBytes) {
			throw new NixDaemonFieldTooLargeError(
				field,
				maximumDaemonScalarBytes,
				length
			);
		}

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
		return integerFromWire(await this.transport.read(8));
	}

	// A structural NAR token, decoded for the grammar walk, with the raw wire
	// frames so the copy re-emits exactly what was read.
	private async readNarWord(): Promise<{
		readonly word: string;
		readonly frames: readonly Uint8Array[];
	}> {
		const header = await this.transport.read(8);
		const length = integerFromWire(header);

		if (length > maxNarWordLength) {
			throw new InvalidNixDaemonNarError(
				`a grammar token of ${String(length)} bytes`
			);
		}

		if (length === 0) {
			return { word: '', frames: [header] };
		}

		const padded = await this.transport.read(length + paddingLength(length));
		const word = new TextDecoder().decode(padded.subarray(0, length));

		return { word, frames: [header, padded] };
	}

	private async *copyNarWord(expected: string): AsyncIterable<Uint8Array> {
		const { word, frames } = await this.readNarWord();

		if (word !== expected) {
			throw new InvalidNixDaemonNarError(
				`'${word}' where '${expected}' belongs`
			);
		}

		yield* frames;
	}

	// A value string (file contents, a symlink target, an entry name) passes
	// through in bounded chunks without being decoded.
	private async *copyNarBlob(): AsyncIterable<Uint8Array> {
		const header = await this.transport.read(8);
		const length = integerFromWire(header);
		yield header;

		let remaining = length + paddingLength(length);

		while (remaining > 0) {
			const chunk = await this.transport.read(
				Math.min(remaining, narChunkSize)
			);
			remaining -= chunk.byteLength;
			yield chunk;
		}
	}

	// The daemon writes the NAR serialisation directly after the stderr
	// stream settles, with no framing of its own: the NAR grammar is the only
	// delimiter, so the copy walks the grammar to know where the archive
	// ends while re-emitting every byte unchanged.
	private async *copyNar(): AsyncIterable<Uint8Array> {
		yield* this.copyNarWord('nix-archive-1');
		yield* this.copyNarNode();
	}

	private async *copyNarNode(): AsyncIterable<Uint8Array> {
		yield* this.copyNarWord('(');
		yield* this.copyNarWord('type');

		const { word, frames } = await this.readNarWord();
		yield* frames;

		if (word === 'regular') {
			yield* this.copyNarRegular();
			return;
		}

		if (word === 'symlink') {
			yield* this.copyNarWord('target');
			yield* this.copyNarBlob();
			yield* this.copyNarWord(')');
			return;
		}

		if (word === 'directory') {
			yield* this.copyNarDirectory();
			return;
		}

		throw new InvalidNixDaemonNarError(`a node of type '${word}'`);
	}

	private async *copyNarRegular(): AsyncIterable<Uint8Array> {
		const { word, frames } = await this.readNarWord();
		yield* frames;

		if (word === 'executable') {
			yield* this.copyNarWord('');
			yield* this.copyNarWord('contents');
			yield* this.copyNarBlob();
			yield* this.copyNarWord(')');
			return;
		}

		if (word === 'contents') {
			yield* this.copyNarBlob();
			yield* this.copyNarWord(')');
			return;
		}

		throw new InvalidNixDaemonNarError(`'${word}' inside a regular file node`);
	}

	private async *copyNarDirectory(): AsyncIterable<Uint8Array> {
		for (;;) {
			const { word, frames } = await this.readNarWord();
			yield* frames;

			if (word === ')') {
				return;
			}

			if (word !== 'entry') {
				throw new InvalidNixDaemonNarError(`'${word}' inside a directory node`);
			}

			yield* this.copyNarWord('(');
			yield* this.copyNarWord('name');
			yield* this.copyNarBlob();
			yield* this.copyNarWord('node');
			yield* this.copyNarNode();
			yield* this.copyNarWord(')');
		}
	}

	get trust(): NixDaemonTrust {
		return this.trustLevel;
	}

	get supportsQueryPathInfos(): boolean {
		return this.features.has(featureQueryPathInfos);
	}

	ageAt(now: number): number {
		return (now - this.openedAt) / 1000;
	}

	close(): Promise<void> {
		this.closePromise ??= this.closeTransport();

		return this.closePromise;
	}

	async initialise(): Promise<void> {
		await this.handshake();
		await this.postHandshake();
		await this.processStderr();

		if (!this.shouldPreserveDaemonOptions) {
			await this.setOptions();
		}
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

		const validPaths = await this.readStringSet(
			'valid paths',
			Math.min(maximumDaemonCollectionEntries, new Set(storePaths).size)
		);

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

		const substitutablePaths = await this.readStringSet(
			'substitutable paths',
			Math.min(maximumDaemonCollectionEntries, new Set(storePaths).size)
		);

		return substitutablePaths.map((path) => requireStorePath(path));
	}

	/**
	 * What the substituters this connection permits offer for each given path.
	 * The answer describes the substituters alone, so a path this machine
	 * already holds is reported only when a substituter serves it too, and
	 * nothing but metadata crosses the wire.
	 *
	 * Whether a path's signatures are acceptable is not decided here: the daemon
	 * applies its own `trusted-public-keys` policy, so a result from this
	 * operation does not guarantee that the daemon will accept the path when the
	 * substitution runs.
	 */
	async querySubstitutablePathInfos(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixDaemonOffer[]> {
		if (this.version.minor < minimumSubstitutablePathInfosMinor) {
			throw new UnsupportedNixDaemonOperationError(
				'QuerySubstitutablePathInfos',
				this.version
			);
		}

		const request = new NixDaemonWriter();
		request.writeInteger(opQuerySubstitutablePathInfos);
		// A map from store path to the content address to look that path up
		// under. Cupboard asks about paths exactly as the store names them, so
		// every entry's address is absent, which the wire spells as an empty
		// string.
		request.writeInteger(storePaths.length);

		for (const storePath of storePaths) {
			request.writeString(storePath);
			request.writeString('');
		}

		await this.transport.write(request.bytes());
		await this.processStderr();

		const count = await this.readCount(
			'substitutable path infos',
			Math.min(maximumDaemonCollectionEntries, new Set(storePaths).size)
		);
		const infos: NixDaemonOffer[] = [];

		for (let index = 0; index < count; index += 1) {
			const storePath = requireStorePath(
				await this.readString('substitutable path info path')
			);
			const deriver = emptyStringToUndefined(
				await this.readString('substitutable path info deriver')
			);
			const references = await this.readStorePathSet(
				'substitutable path info references'
			);
			const downloadSize = await this.readInteger();
			const narSize = await this.readInteger();

			infos.push({
				source: 'daemon',
				storePath,
				references,
				downloadSize,
				narSize,
				...(deriver !== undefined && { deriver })
			});
		}

		return infos;
	}

	async queryPathsInfo(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]> {
		const expected = new Set<string>(storePaths);
		const request = new NixDaemonWriter();
		request.writeInteger(opQueryPathInfos);
		request.writeStringSet(storePaths);

		await this.transport.write(request.bytes());
		await this.processStderr();

		const count = await this.readCount(
			'path infos',
			Math.min(maximumDaemonCollectionEntries, expected.size)
		);
		const infos: NixValidPathInfo[] = [];

		for (let index = 0; index < count; index += 1) {
			const reported = await this.readString('path info path');

			if (!expected.delete(reported)) {
				throw new NixDaemonRemoteError(
					`daemon returned path info for an unexpected path: ${reported}`
				);
			}

			const storePath = requireStorePath(reported);
			const pathInfo = await this.readUnkeyedPathInfo();

			infos.push({
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
			});
		}

		return infos;
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

	async readDerivation(drvPath: StorePathString): Promise<string> {
		return new TextDecoder().decode(
			await narRegularFileContents(this.narFromPath(drvPath))
		);
	}

	async *narFromPath(storePath: StorePathString): AsyncIterable<Uint8Array> {
		const request = new NixDaemonWriter();
		request.writeInteger(opNarFromPath);
		request.writeString(storePath);

		await this.transport.write(request.bytes());
		await this.processStderr();

		yield* this.copyNar();
	}

	async buildPathsWithResults(
		targets: readonly NixDerivedPathString[],
		mode: NixBuildMode = 'normal'
	): Promise<readonly NixBuildResult[]> {
		if (this.version.minor < minimumBuildResultsMinor) {
			throw new UnsupportedNixDaemonOperationError(
				'BuildPathsWithResults',
				this.version
			);
		}

		const request = new NixDaemonWriter();
		request.writeInteger(opBuildPathsWithResults);
		request.writeStringSet(targets.map((target) => legacyDerivedPath(target)));
		request.writeInteger(buildModeWireValue(mode));

		await this.transport.write(request.bytes());
		await this.processStderr();

		const count = await this.readCount(
			'build results',
			Math.min(maximumDaemonCollectionEntries, new Set(targets).size)
		);
		const results: NixBuildResult[] = [];

		for (let index = 0; index < count; index += 1) {
			results.push(await this.readKeyedBuildResult());
		}

		return results;
	}

	async queryMissing(
		targets: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition> {
		const request = new NixDaemonWriter();
		request.writeInteger(opQueryMissing);
		request.writeStringSet(targets.map((target) => legacyDerivedPath(target)));

		await this.transport.write(request.bytes());
		await this.processStderr();

		const buildPaths = await this.readStorePathSet(
			'paths to build',
			maximumDaemonCollectionEntries
		);
		const substitutePaths = await this.readStorePathSet(
			'paths to substitute',
			maximumDaemonCollectionEntries - buildPaths.length
		);
		const unknownPaths = await this.readStorePathSet(
			'unknown paths',
			maximumDaemonCollectionEntries -
				buildPaths.length -
				substitutePaths.length
		);
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
		const count = await this.readCount(
			'derivation outputs',
			maximumDaemonDerivationOutputs
		);

		// One (output name, store path) pair per entry; an unbuilt output has an
		// empty path.
		for (let index = 0; index < count; index += 1) {
			await this.readString('derivation output name');
			const outputPath = emptyStringToUndefined(
				await this.readString('derivation output path')
			);

			if (outputPath !== undefined) {
				outputPaths.push(requireStorePath(outputPath));
			}
		}

		return outputPaths;
	}
}

class NixDaemonWriter {
	private readonly chunks: Buffer[] = [];

	// The protocol carries every number in eight bytes, and reads some of them
	// back into a signed width, so a negative value is written as its
	// two's-complement bytes.
	writeInteger(value: number): void {
		const bytes = Buffer.alloc(8);
		bytes.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)));
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
	private readonly reader: ByteStreamReader;

	private closePromise?: Promise<void>;

	constructor(private readonly socket: Socket) {
		this.reader = new ByteStreamReader(socket);
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

/** The events a byte source emits for {@link ByteStreamReader} to buffer it. */
export interface ByteStreamSource {
	on(event: 'data', listener: (chunk: Buffer) => void): unknown;
	once(
		event: 'end' | 'close' | 'error',
		listener: (error: Error) => void
	): unknown;
	pause(): unknown;
	resume(): unknown;
}

/**
 * Buffers a byte stream (a socket, a child process pipe) and serves
 * exact-length reads, which is how the daemon protocol consumes bytes. When the
 * stream ends or fails, any pending read the buffered bytes cannot satisfy
 * fails with that error.
 */
export class ByteStreamReader {
	private readonly chunks: Buffer[] = [];

	private bufferedBytes = 0;

	private pending?: PendingRead;

	private ended = false;

	private failure?: Error;

	constructor(private readonly source: ByteStreamSource) {
		source.pause();
		source.on('data', (chunk: Buffer) => {
			this.chunks.push(chunk);
			this.bufferedBytes += chunk.byteLength;

			if (
				this.pending === undefined ||
				this.bufferedBytes >= this.pending.byteLength
			) {
				this.source.pause();
			}

			this.resolvePendingRead();
		});
		source.once('end', () => {
			this.ended = true;
			this.resolvePendingRead();
		});
		source.once('close', () => {
			this.ended = true;
			this.resolvePendingRead();
		});
		source.once('error', (error) => {
			this.fail(error);
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

	/**
	 * Fail any pending read with an error the source's own `error` event does not
	 * report.
	 */
	fail(error: Error): void {
		this.source.pause();
		this.failure = error;
		this.resolvePendingRead();
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
			this.source.resume();
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
	return [...new Set(values)].toSorted(byCodeUnit);
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

function modernDerivedPath(wire: string): NixDerivedPathString {
	const separator = wire.indexOf('!');

	if (separator === -1) {
		return requireStorePath(wire);
	}

	const drvPath = requireStorePath(wire.slice(0, separator));

	return `${drvPath}^${wire.slice(separator + 1)}`;
}

function outputNameFromDrvOutputId(id: string): string {
	const separator = id.indexOf('!');

	if (separator === -1) {
		throw new NixDaemonRemoteError(`malformed derivation output id: ${id}`);
	}

	return id.slice(separator + 1);
}

function realisationOutputPath(
	json: string,
	storeDirectory: StoreDirectory
): StorePathString {
	let parsed: unknown;

	try {
		parsed = JSON.parse(json);
	} catch {
		throw new NixDaemonRemoteError('realisation that is not JSON');
	}

	if (
		parsed === null ||
		typeof parsed !== 'object' ||
		!('outPath' in parsed) ||
		typeof parsed.outPath !== 'string'
	) {
		throw new NixDaemonRemoteError('realisation without an outPath');
	}

	const reported = parsed.outPath;
	const outputPath = requireStorePath(
		reported.startsWith('/') ? reported : `${storeDirectory}/${reported}`
	);

	if (!outputPath.startsWith(`${storeDirectory}/`)) {
		throw new NixDaemonRemoteError(
			`realisation outPath outside ${storeDirectory}: ${reported}`
		);
	}

	return outputPath;
}

const buildSuccessKinds = [
	'built',
	'substituted',
	'already-valid',
	'resolves-to-already-valid'
] as const;

function isBuildSuccessKind(
	kind: (typeof buildStatusKinds)[number]
): kind is (typeof buildSuccessKinds)[number] {
	const kinds: readonly string[] = buildSuccessKinds;

	return kinds.includes(kind);
}

function buildOutcome(
	status: number,
	message: string,
	outputs: Readonly<Record<string, StorePathString>>
): NixBuildOutcome {
	const kind = buildStatusKinds[status];

	if (kind === undefined) {
		throw new NixDaemonRemoteError(`unknown build status ${String(status)}`);
	}

	if (isBuildSuccessKind(kind)) {
		return { kind, outputs };
	}

	return { kind, message };
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

function integerFromWire(bytes: Uint8Array): number {
	const value = Buffer.from(bytes).readBigUInt64LE();

	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new NixDaemonRemoteError(
			`integer too large for JavaScript number: ${value.toString()}`
		);
	}

	return Number(value);
}

function emptyStringToUndefined(value: string): string | undefined {
	return value === '' ? undefined : value;
}
