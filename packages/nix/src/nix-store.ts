import type { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type StoreDirectory,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';

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

/** A store backend: how a single path's info is fetched from this kind of store. */
export interface NixStoreClient {
	resolveClosure(
		storePaths: readonly StorePathString[]
	): Promise<readonly NixValidPathInfo[]>;
	queryPathInfo(storePath: StorePathString): Promise<NixValidPathInfo>;
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
function claimUnseen(
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

export class NotInNixStoreError extends NixStoreError {
	constructor(
		public readonly path: string,
		public readonly storeDirectory: StoreDirectory
	) {
		super(`${path} is not inside the Nix store ${storeDirectory}`);
		this.name = 'NotInNixStoreError';
	}
}
