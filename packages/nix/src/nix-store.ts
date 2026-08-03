import type { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type StoreDirectory,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

/**
 * Whether the daemon trusts this client, as the handshake reports it:
 * `unknown` when the daemon leaves the flag unset.
 */
export type NixDaemonTrust = 'trusted' | 'not-trusted' | 'unknown';

export interface NixValidPathInfo {
	readonly storePath: StorePathString;
	readonly narHash: NixSha256Hash;
	readonly narSize: number;
	readonly references: readonly StorePathString[];
	readonly deriver?: string;
	readonly ca?: string;
	readonly signatures: readonly string[];
	/**
	 * Whether this store registered the path as ultimately trusted, which Nix
	 * sets for paths it built locally. A substituted path carries the
	 * substituter's signatures instead.
	 */
	readonly ultimate: boolean;
}

/**
 * What a substituter offers for one store path: enough metadata to walk the
 * path's closure without fetching any of its bytes. A store answers with an
 * entry only for a path one of its permitted substituters serves, whatever
 * this machine's own store already holds.
 */
export interface NixSubstitutablePathInfo {
	readonly storePath: StorePathString;
	readonly deriver?: string;
	readonly references: readonly StorePathString[];
	/** Bytes the fetch would transfer; 0 when the substituter does not say. */
	readonly downloadSize: number;
	/** Bytes the path would occupy; 0 when the substituter does not say. */
	readonly narSize: number;
}

/**
 * A realisation target the way an installable names one: a plain store path,
 * or a derivation path followed by `^` and the outputs it should produce
 * (`^*` for all of them).
 */
export type NixDerivedPathString =
	StorePathString | `${StorePathString}^${string}`;

/**
 * What realising a set of targets would require, partitioned the way
 * `Store::queryMissing` answers it. An already-valid target appears in no
 * set. `downloadSize` and `narSize` describe the substitutable set: the bytes
 * substitution would download and the NAR bytes it would materialise.
 */
export interface NixMissingPartition {
	readonly willBuild: readonly StorePathString[];
	readonly willSubstitute: readonly StorePathString[];
	readonly unknown: readonly StorePathString[];
	readonly downloadSize: number;
	readonly narSize: number;
}

/**
 * How a build request settled for one derived path. A settled target carries
 * the realised outputs the daemon reported by name; a failed one carries the
 * daemon's message.
 */
export type NixBuildOutcome =
	| {
			readonly kind:
				'built' | 'substituted' | 'already-valid' | 'resolves-to-already-valid';
			readonly outputs: Readonly<Record<string, StorePathString>>;
	  }
	| {
			readonly kind:
				| 'permanent-failure'
				| 'input-rejected'
				| 'output-rejected'
				| 'transient-failure'
				| 'cached-failure'
				| 'timed-out'
				| 'misc-failure'
				| 'dependency-failed'
				| 'log-limit-exceeded'
				| 'not-deterministic'
				| 'no-substituters';
			readonly message: string;
	  };

/** One target's build result, keyed by the derived path that named it. */
export interface NixBuildResult {
	readonly target: NixDerivedPathString;
	readonly outcome: NixBuildOutcome;
	readonly timesBuilt: number;
	readonly nonDeterministic: boolean;
	readonly startTime: number;
	readonly stopTime: number;
}

/** Operations provided by a selected Nix store backend. */
export interface NixStoreClient {
	resolveClosure(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]>;
	queryPathInfo(storePath: StorePathString): Promise<NixValidPathInfo>;
	/**
	 * Path information for every given path, in argument order. A path the
	 * store does not hold fails the whole query with
	 * {@link NixStorePathNotFoundError}.
	 */
	queryPathsInfo(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]>;
	/**
	 * Path information for the given paths the store holds, in argument
	 * order; a path it does not hold is left out.
	 */
	queryValidPathsInfo(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]>;
	/**
	 * The subset of the given paths this store holds as valid, deduplicated
	 * and sorted by store path.
	 */
	queryValidPaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]>;
	/**
	 * The subset of the given paths available from the store's configured
	 * substituters, deduplicated and sorted by store path.
	 */
	querySubstitutablePaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]>;
	/**
	 * What the store's permitted substituters offer for each of the given
	 * paths, sorted by store path. A path no substituter serves has no entry,
	 * and a path this machine already holds is answered no differently from
	 * one it does not: the question is what is available elsewhere.
	 */
	querySubstitutablePathInfos(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixSubstitutablePathInfo[]>;
	/**
	 * The registered output paths of the given derivations, deduplicated and
	 * sorted by store path. An output that was never built has no registered
	 * path and is left out.
	 */
	queryDerivationOutputPaths(
		drvPaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]>;
	/**
	 * What realising the given targets would require, answered against this
	 * store's validity and its configured substituters. Every set comes back
	 * deduplicated and sorted by store path.
	 */
	queryMissing(
		targets: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition>;
	/**
	 * The NAR serialisation of the given path, streamed as the store reads
	 * it.
	 */
	narFromPath(storePath: StorePathString): AsyncIterable<Uint8Array>;
	/**
	 * Build the given targets and report how each one settled: exact
	 * per-target outcomes, with the realised outputs where the store reports
	 * them.
	 */
	buildPathsWithResults(
		targets: readonly NixDerivedPathString[]
	): Promise<readonly NixBuildResult[]>;
	/**
	 * Whether the daemon connection this client uses is trusted, so a caller
	 * can tell whether a setting override it sent (such as a negative-cache
	 * bypass) actually took effect. Only a daemon-backed store has a
	 * connection to ask; a backend without one leaves this undefined.
	 */
	daemonTrust?(): Promise<NixDaemonTrust>;
}

/**
 * The store path a backend reported, refusing a value that cannot name one. A
 * store path a reader hands on is the key every later stage indexes, hashes and
 * uploads by, so a value the schema cannot accept is refused here, naming the
 * store that reported it, and never reaches those stages.
 */
export function requireStorePath(reported: string): StorePathString {
	const storePath = storePathSchema.safeParse(reported);

	if (!storePath.success) {
		throw new InvalidNixStorePathError(reported);
	}

	return storePath.data;
}

/**
 * How many path-info queries the closure walk runs at once by default. A daemon
 * query is a round-trip the walk would otherwise pay one path at a time, so the
 * frontier fans out across this many concurrent queries. The backend must be
 * able to serve this many at once: the daemon store gives each query its own
 * connection.
 */
export const defaultClosureConcurrency = 16;

/**
 * Resolve the closure of `roots` by walking references breadth-first, visiting
 * each path once and returning them sorted by store path. The backend supplies
 * how a single path's info is fetched, so the daemon and local stores share one
 * traversal. The walk queries each frontier with up to `concurrency` queries in
 * flight, so `queryPathInfo` must be safe to call that many times concurrently.
 */
export async function resolveClosureBy(
	roots: readonly StorePathString[],
	queryPathInfo: (storePath: StorePathString) => Promise<NixValidPathInfo>,
	concurrency = 1
): Promise<readonly NixValidPathInfo[]> {
	const closure = new Map<string, NixValidPathInfo>();
	const claimed = new Set<string>();
	let frontier = claimUnseen(roots, claimed);

	while (frontier.length > 0) {
		const infos = await mapWithConcurrency(
			frontier,
			concurrency,
			queryPathInfo
		);
		const references: StorePathString[] = [];

		for (const info of infos) {
			closure.set(info.storePath, info);
			references.push(...info.references);
		}

		frontier = claimUnseen(references, claimed);
	}

	return closure
		.values()
		.toArray()
		.toSorted((left, right) => left.storePath.localeCompare(right.storePath));
}

// The candidates not yet claimed, in order and deduplicated, marking each one
// claimed so a path reachable by several edges is queried once. A path is
// claimed when it joins a frontier, before it is queried, so the next frontier
// never re-schedules a path already in flight.
export function claimUnseen(
	candidates: readonly StorePathString[],
	claimed: Set<string>
): StorePathString[] {
	const next: StorePathString[] = [];

	for (const candidate of candidates) {
		if (claimed.has(candidate)) {
			continue;
		}

		claimed.add(candidate);
		next.push(candidate);
	}

	return next;
}

export abstract class NixStoreError extends Error {}

export class NixStorePathNotFoundError extends NixStoreError {
	constructor(public readonly storePath: string) {
		super(`Nix store path is not registered locally: ${storePath}`);
		this.name = 'NixStorePathNotFoundError';
	}
}

export class InvalidNixStorePathError extends NixStoreError {
	constructor(public readonly path: string) {
		super(
			`The Nix store reported '${path}', which does not name a store path: it must be an absolute directory followed by a 32-character hash, a dash, and a name`
		);
		this.name = 'InvalidNixStorePathError';
	}
}

export class NixConfigIncludeError extends NixStoreError {
	constructor(
		public readonly target: string,
		public readonly reason: string
	) {
		super(`Could not include Nix configuration ${target}: ${reason}`);
		this.name = 'NixConfigIncludeError';
	}
}

export class NixConfigSettingError extends NixStoreError {
	constructor(
		public readonly setting: string,
		public readonly value: string,
		public readonly expected: string
	) {
		super(
			`Nix configuration setting '${setting}' has invalid value '${value}': expected ${expected}`
		);
		this.name = 'NixConfigSettingError';
	}
}

/** The setting a discovered store directory came from. */
export type NixStoreDirectorySource = 'NIX_STORE_DIR' | 'store-dir';

export class InvalidNixStoreDirectoryError extends NixStoreError {
	constructor(
		public readonly storeDirectory: string,
		public readonly source: NixStoreDirectorySource
	) {
		super(
			`The ${source} setting '${storeDirectory}' does not name a Nix store directory: it must be an absolute path of one or more segments, none of them '.' or '..'`
		);
		this.name = 'InvalidNixStoreDirectoryError';
	}
}

export class UnsupportedNixStoreError extends NixStoreError {
	constructor(public readonly storeUri: string) {
		super(
			`Cannot read path information from the Nix store '${storeUri}': only the local store and the daemon are supported`
		);
		this.name = 'UnsupportedNixStoreError';
	}
}

export class NixStoreDatabaseError extends NixStoreError {
	constructor(message: string) {
		super(message);
		this.name = 'NixStoreDatabaseError';
	}
}

export class UnsupportedNixStoreOperationError extends NixStoreError {
	constructor(public readonly operation: string) {
		super(`The selected Nix store does not support ${operation}`);
		this.name = 'UnsupportedNixStoreOperationError';
	}
}

export class NixDaemonUnavailableError extends NixStoreError {
	constructor(public readonly socketPath: string) {
		super(
			`No Nix daemon is available: its socket ${socketPath} does not exist`
		);
		this.name = 'NixDaemonUnavailableError';
	}
}

export class NotInNixStoreError extends NixStoreError {
	constructor(
		public readonly path: string,
		public readonly storeDirectory: StoreDirectory
	) {
		super(`${path} is not inside the Nix store ${storeDirectory}`);
		this.name = 'NotInNixStoreError';
	}
}
