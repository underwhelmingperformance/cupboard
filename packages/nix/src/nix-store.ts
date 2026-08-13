import type { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type StoreDirectory,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

/**
 * Whether the daemon trusts this client, as the handshake reports it:
 * `unknown` when the daemon leaves the flag unset.
 */
export type NixDaemonTrust = 'trusted' | 'not-trusted' | 'unknown';

/**
 * A configured substituter nothing could be asked of. Its answers are missing
 * from every query made without it, so a caller reading those answers as
 * "nobody holds this" is reading them one substituter short.
 */
export type UnreachableSubstituter = {
	readonly uri: string;
} & UnreachableSubstituterCause;

/** Why nothing could be asked of a substituter. */
export type UnreachableSubstituterCause =
	| { readonly reason: 'unreadable-uri' }
	/** A store this reader does not open, such as `s3://` or `ssh://`. */
	| { readonly reason: 'unsupported-scheme' }
	| { readonly reason: 'no-cache-info' }
	/**
	 * The substituter, or a proxy standing in front of it, asked for a
	 * credential this run does not hold. It may well hold the paths asked
	 * about; nothing here could ask it.
	 */
	| { readonly reason: 'needs-credentials' }
	| {
			/**
			 * The substituter serves another store's paths, so nothing it holds
			 * answers a question about this one.
			 */
			readonly reason: 'store-directory-mismatch';
			/** The store directory the substituter serves paths for. */
			readonly servesStoreDirectory: StoreDirectory;
			/** The store directory the answers are for. */
			readonly queriedStoreDirectory: StoreDirectory;
	  };

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
 * What every offer states about one store path, whichever answer carried it:
 * enough metadata to walk the path's closure without fetching any of its
 * bytes.
 */
interface NixOfferedPath {
	readonly storePath: StorePathString;
	readonly deriver?: string;
	readonly references: readonly StorePathString[];
	/**
	 * The bytes the path would occupy, as the answer states them, which the
	 * fingerprint a signature is made over commits to.
	 */
	readonly narSize: number;
	/** Bytes the fetch would transfer; 0 when the answer does not say. */
	readonly downloadSize: number;
}

/**
 * An offer as the daemon's batched answer carries one. That answer names the
 * sizes and the references and nothing else, so it says how much work a fetch
 * would be and nothing about what the fetch would produce.
 */
export interface NixDaemonOffer extends NixOfferedPath {
	readonly source: 'daemon';
}

/**
 * An offer read from a substituter's own narinfo, which every substituter
 * publishes in full: the path's NAR hash and each signature made over it, so a
 * consumer's checks can run against what this substituter would serve.
 */
export interface NixSubstituterOffer extends NixOfferedPath {
	readonly source: 'substituter';
	/** The NAR hash the substituter would serve the path under. */
	readonly narHash: NixSha256Hash;
	/** The signatures the substituter published for the path. */
	readonly signatures: readonly string[];
	/**
	 * Whether the substituter that made this offer is configured as trusted,
	 * which takes what it serves without asking for a signature.
	 */
	readonly fromTrustedSubstituter: boolean;
}

/**
 * What a substituter offers for one store path, as the answer that carried it
 * can state. A store answers with an entry only for a path one of its
 * permitted substituters serves, whatever this machine's own store already
 * holds.
 */
export type NixSubstitutablePathInfo = NixDaemonOffer | NixSubstituterOffer;

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
	/** Whether this transport deliberately omits per-connection SetOptions. */
	readonly preservesDaemonOptions?: boolean;
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
	 * The serialised text of the derivation at the given path. A derivation is
	 * one regular file in the store, so a backend that reaches those files
	 * reads it directly and one that reaches the store only over the worker
	 * protocol extracts it from the path's NAR.
	 */
	readDerivation(drvPath: StorePathString): Promise<string>;
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
	/**
	 * The store's configured substituters that nothing could be asked of, so a
	 * caller can tell an answer of "nobody holds this" from one given without
	 * asking everybody. Only a store this process drives knows; a daemon keeps
	 * its own substituters and reports what it reached to its own log.
	 */
	unreachableSubstituters?(): Promise<readonly UnreachableSubstituter[]>;
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
		.toSorted((left, right) => byCodeUnit(left.storePath, right.storePath));
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
	constructor(
		public readonly storePath: string,
		options?: ErrorOptions
	) {
		super(`Nix store path is not registered locally: ${storePath}`, options);
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

/** Why an `include` line could not be followed. */
export type NixConfigIncludeFailure =
	| 'too-many-nested-includes'
	| 'file-does-not-exist'
	/**
	 * A relative target written where nothing names a directory for it to sit
	 * under, which is every line of an inline `NIX_CONFIG`.
	 */
	| 'not-an-absolute-path';

const includeFailureDescriptions: Readonly<
	Record<NixConfigIncludeFailure, string>
> = {
	'too-many-nested-includes': 'too many nested includes',
	'file-does-not-exist': 'the file does not exist',
	'not-an-absolute-path': 'it is not an absolute path'
};

export class NixConfigIncludeError extends NixStoreError {
	constructor(
		public readonly target: string,
		public readonly reason: NixConfigIncludeFailure
	) {
		super(
			`Could not include Nix configuration ${target}: ${includeFailureDescriptions[reason]}`
		);
		this.name = 'NixConfigIncludeError';
	}
}

/**
 * A configuration line Nix cannot read as one. Nix takes a line's
 * whitespace-separated tokens and requires `<name> = <value…>`, refusing the
 * whole configuration over anything else, so a client reading that
 * configuration refuses it too: carrying on would run under settings Nix
 * itself would not start with.
 */
export class NixConfigSyntaxError extends NixStoreError {
	constructor(
		public readonly line: string,
		public readonly source: string
	) {
		super(`Syntax error in Nix configuration line '${line}' in ${source}`);
		this.name = 'NixConfigSyntaxError';
	}
}

/**
 * A netrc nothing can be read out of. Nix hands the file to libcurl, which
 * fails the transfer over a line it cannot read rather than carrying on
 * without the credentials the file was there to supply.
 */
export class NixNetrcSyntaxError extends NixStoreError {
	constructor(public readonly found: string) {
		super(`The netrc file could not be read: it holds ${found}`);
		this.name = 'NixNetrcSyntaxError';
	}
}

/** Why a `builders` value's `@file` entries could not be expanded. */
export type NixMachineFileFailure =
	'too-many-nested-machine-files' | 'file-could-not-be-read';

const machineFileFailureDescriptions: Readonly<
	Record<NixMachineFileFailure, string>
> = {
	'too-many-nested-machine-files': 'too many nested machine files',
	'file-could-not-be-read': 'the file could not be read'
};

/**
 * A `builders` value whose `@file` entries could not be expanded. A machines
 * file may name another, so a chain of them can be followed only so far.
 */
export class NixMachineFileError extends NixStoreError {
	constructor(
		/** The builders value, or the machines file, the failure is about. */
		public readonly source: string,
		public readonly reason: NixMachineFileFailure,
		options?: ErrorOptions
	) {
		super(
			`Could not read the Nix builders '${source}': ${machineFileFailureDescriptions[reason]}`,
			options
		);
		this.name = 'NixMachineFileError';
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
export type NixStoreDirectorySource = 'NIX_STORE_DIR' | 'NIX_STORE';

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

/**
 * A local store URI naming a directory by something other than an absolute
 * path. Nix reads each of these parameters as a path from the filesystem root,
 * and refuses a store URI naming one any other way.
 */
export class InvalidNixStoreParameterError extends NixStoreError {
	constructor(
		public readonly parameter: string,
		public readonly value: string
	) {
		super(
			`The store parameter '${parameter}' names '${value}', which is not an absolute path`
		);
		this.name = 'InvalidNixStoreParameterError';
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
