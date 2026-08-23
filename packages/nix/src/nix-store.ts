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
 * A configured substituter that the client could not query. Availability
 * results are incomplete while any substituter is unreachable.
 */
export type UnreachableSubstituter = {
	readonly uri: string;
} & UnreachableSubstituterCause;

export type UnreachableSubstituterCause =
	| { readonly reason: 'unreadable-uri' }
	/**
	The URI uses an unsupported store scheme, such as `s3://` or `ssh://`.
	*/
	| { readonly reason: 'unsupported-scheme' }
	| { readonly reason: 'no-cache-info' }
	/**
	 * The substituter, or a proxy standing in front of it, asked for a
	 * credential unavailable to this run. The client cannot determine which
	 * paths that substituter has.
	 */
	| { readonly reason: 'needs-credentials' }
	| {
			readonly reason: 'store-directory-mismatch';
			readonly servesStoreDirectory: StoreDirectory;
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
	 * sets for paths it built locally. A substituted path records the
	 * substituter's signatures instead.
	 */
	readonly ultimate: boolean;
}

interface NixOfferedPath {
	readonly storePath: StorePathString;
	readonly deriver?: string;
	readonly references: readonly StorePathString[];
	/**
	Signature verification includes this uncompressed size in the fingerprint.
	*/
	readonly narSize: number;
	/**
	Expected transfer size in bytes. Zero means no size was provided.
	*/
	readonly downloadSize: number;
}

/**
 * An offer from the daemon's batched response. It includes sizes and
 * references but omits the NAR hash and signatures.
 */
export interface NixDaemonOffer extends NixOfferedPath {
	readonly source: 'daemon';
}

/**
 * An offer parsed from a substituter's narinfo. It includes the advertised NAR
 * hash and every `Sig` entry. Consumers use this evidence for signature and
 * policy checks before fetching the path.
 */
export interface NixSubstituterOffer extends NixOfferedPath {
	readonly source: 'substituter';
	readonly narHash: NixSha256Hash;
	readonly signatures: readonly string[];
	/**
	 * Whether the substituter that made this offer is configured as trusted. Nix
	 * accepts a path from a trusted substituter without checking its signatures.
	 */
	readonly fromTrustedSubstituter: boolean;
}

/**
 * An offer from a configured substituter for one store path. Local validity
 * does not affect whether an offer is returned.
 */
export type NixSubstitutablePathInfo = NixDaemonOffer | NixSubstituterOffer;

/**
 * A realisation target in installable form: a plain store path,
 * or a derivation path followed by `^` and the outputs it should produce
 * (`^*` for all of them).
 */
export type NixDerivedPathString =
	StorePathString | `${StorePathString}^${string}`;

/**
 * The work required to realise a set of targets, partitioned like
 * `Store::queryMissing`. An already-valid target appears in no
 * set. `downloadSize` is the number of bytes to transfer for the substitutable
 * paths. `narSize` is their total uncompressed size.
 */
export interface NixMissingPartition {
	readonly willBuild: readonly StorePathString[];
	readonly willSubstitute: readonly StorePathString[];
	readonly unknown: readonly StorePathString[];
	readonly downloadSize: number;
	readonly narSize: number;
}

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

export interface NixBuildResult {
	readonly target: NixDerivedPathString;
	readonly outcome: NixBuildOutcome;
	readonly timesBuilt: number;
	readonly nonDeterministic: boolean;
	readonly startTime: number;
	readonly stopTime: number;
}

export type NixBuildMode = 'normal' | 'check';

export interface NixStoreClient {
	/**
	Whether this transport must preserve daemon policy and therefore omits the
	per-connection SetOptions frame.
	*/
	readonly preservesDaemonOptions?: boolean;
	/**
	 * Returns the stores each path was copied from, in the order the store
	 * reported them. A client that cannot observe copies does not implement this
	 * method.
	 */
	observedCopies?: () => ReadonlyMap<StorePathString, readonly string[]>;
	resolveClosure(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]>;
	queryPathInfo(storePath: StorePathString): Promise<NixValidPathInfo>;
	/**
	 * Path information for every given path, in argument order. A path absent
	 * from the store fails the whole query with
	 * {@link NixStorePathNotFoundError}.
	 */
	queryPathsInfo(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]>;
	/**
	 * Path information for the given paths that are valid in the store, in
	 * argument order. Invalid or absent paths are omitted.
	 */
	queryValidPathsInfo(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]>;
	/**
	 * Returns the given paths that are valid in this store, deduplicated and
	 * sorted by store path.
	 */
	queryValidPaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]>;
	/**
	 * Returns the given paths available from the store's configured substituters,
	 * deduplicated and sorted by store path.
	 */
	querySubstitutablePaths(
		storePaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]>;
	/**
	 * Offers from the store's permitted substituters for the given paths, sorted
	 * by store path. Paths without offers are omitted. Local path validity does
	 * not affect external availability.
	 */
	querySubstitutablePathInfos(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixSubstitutablePathInfo[]>;
	/**
	 * Returns registered output paths for the given derivations, deduplicated and
	 * sorted by store path. An output that was never built has no registered path
	 * and is left out.
	 */
	queryDerivationOutputPaths(
		drvPaths: readonly StorePathString[]
	): Promise<readonly StorePathString[]>;
	/**
	 * Partitions the work required to realise the targets against this store's
	 * validity and its configured substituters. Every set comes back deduplicated
	 * and sorted by store path.
	 */
	queryMissing(
		targets: readonly NixDerivedPathString[]
	): Promise<NixMissingPartition>;
	/**
	 * Reads the serialised derivation at the given path. Local backends read the
	 * regular file directly; worker-protocol backends extract the file from the
	 * path's NAR.
	 */
	readDerivation(drvPath: StorePathString): Promise<string>;
	narFromPath(storePath: StorePathString): AsyncIterable<Uint8Array>;
	buildPathsWithResults(
		targets: readonly NixDerivedPathString[],
		mode?: NixBuildMode
	): Promise<readonly NixBuildResult[]>;
	/**
	 * Reports whether the daemon connection is trusted, allowing callers to
	 * check whether overrides such as a negative-cache bypass took effect.
	 * Non-daemon backends omit this method.
	 */
	daemonTrust?(): Promise<NixDaemonTrust>;
	/**
	 * Configured substituters that could not be queried. This distinguishes a
	 * confirmed absence from an incomplete query. Process-driven stores expose
	 * individual failures. A daemon manages its own substituters and records
	 * reachability in its log instead.
	 */
	unreachableSubstituters?(): Promise<readonly UnreachableSubstituter[]>;
}

/**
 * Validates a store path reported by a backend before later stages use it as an
 * index, hash input, or upload key.
 */
export function requireStorePath(reported: string): StorePathString {
	const storePath = storePathSchema.safeParse(reported);

	if (!storePath.success) {
		throw new InvalidNixStorePathError(reported);
	}

	return storePath.data;
}

/**
 * How many path-info queries the closure walk runs at once by default. Each
 * path-info query is one round trip to the backend, and a serial walk would
 * make that round trip once per path, so each frontier is queried with this
 * many requests in flight. The backend must be able to serve this many at
 * once: the daemon store gives each query its own connection.
 */
export const defaultClosureConcurrency = 16;

/**
 * Walks references breadth-first, visits each path once, and returns paths
 * sorted by store path. The injected `queryPathInfo` operation lets daemon and
 * local stores share the traversal. Each frontier runs at most `concurrency`
 * queries, so the callback must support that concurrency.
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

// Return unseen candidates in input order without duplicates, and add them to
// claimed before querying. Claiming at frontier construction prevents another
// edge from scheduling an in-flight path again.
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
			`The Nix store returned an invalid store path '${path}': expected an absolute directory followed by a 32-character hash, a dash, and a name`
		);
		this.name = 'InvalidNixStorePathError';
	}
}

export type NixConfigIncludeFailure =
	| 'too-many-nested-includes'
	| 'file-does-not-exist'
	/**
	 * A relative target from a source with no containing directory, such as
	 * inline `NIX_CONFIG`.
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
 * A configuration line Nix cannot parse. Nix tokenises the line on whitespace
 * and requires `<name> = <value…>`. It rejects the complete configuration for
 * any other form. This client also rejects malformed lines so it cannot
 * proceed under a configuration Nix would reject.
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
 * A malformed netrc. Nix delegates parsing to libcurl, which fails the
 * transfer instead of proceeding without the expected credentials.
 */
export class NixNetrcSyntaxError extends NixStoreError {
	constructor(public readonly found: string) {
		super(`The netrc file is invalid: it contains ${found}`);
		this.name = 'NixNetrcSyntaxError';
	}
}

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
 * file may include another, so a chain of them can be followed only so far.
 * `source` contains the original builders value when nesting is too deep, or
 * the machines file path when a read fails.
 */
export class NixMachineFileError extends NixStoreError {
	constructor(
		public readonly source: string,
		public readonly reason: NixMachineFileFailure,
		options?: ErrorOptions
	) {
		super(machineFileFailureMessage(source, reason), options);
		this.name = 'NixMachineFileError';
	}
}

function machineFileFailureMessage(
	source: string,
	reason: NixMachineFileFailure
): string {
	return reason === 'too-many-nested-machine-files'
		? `Could not expand Nix builders '${source}': ${machineFileFailureDescriptions[reason]}`
		: `Could not read Nix machines file '${source}'`;
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

export type NixStoreDirectorySource = 'NIX_STORE_DIR' | 'NIX_STORE';

export class InvalidNixStoreDirectoryError extends NixStoreError {
	constructor(
		public readonly storeDirectory: string,
		public readonly source: NixStoreDirectorySource
	) {
		super(
			`${source} contains invalid Nix store directory '${storeDirectory}': expected an absolute path of one or more segments, none of them '.' or '..'`
		);
		this.name = 'InvalidNixStoreDirectoryError';
	}
}

/**
 * A local store URI with a relative directory parameter. Nix resolves these
 * parameters from the filesystem root and rejects every non-absolute value.
 */
export class InvalidNixStoreParameterError extends NixStoreError {
	constructor(
		public readonly parameter: string,
		public readonly value: string
	) {
		super(
			`Store parameter '${parameter}' must be an absolute path, got '${value}'`
		);
		this.name = 'InvalidNixStoreParameterError';
	}
}

export class UnsupportedNixStoreError extends NixStoreError {
	constructor(public readonly storeUri: string) {
		super(
			`Cannot read path information from the Nix store '${storeUri}': only the local store, the daemon and an ssh-ng remote are supported`
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
