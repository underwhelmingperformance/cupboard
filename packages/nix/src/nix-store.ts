import type { NixSha256Hash } from '@cupboard/nix-store/hash';

export interface NixValidPathInfo {
	readonly storePath: string;
	readonly narHash: NixSha256Hash;
	readonly narSize: number;
	readonly references: readonly string[];
	readonly deriver?: string;
	readonly ca?: string;
	readonly signatures: readonly string[];
}

/** A store backend: how a single path's info is fetched from this kind of store. */
export interface NixStoreClient {
	resolveClosure(
		storePaths: readonly string[]
	): Promise<readonly NixValidPathInfo[]>;
	queryPathInfo(storePath: string): Promise<NixValidPathInfo>;
}

/**
 * Resolve the closure of `roots` by walking references breadth-first, visiting
 * each path once and returning them sorted by store path. The backend supplies
 * how a single path's info is fetched, so the daemon and local stores share one
 * traversal.
 */
export async function resolveClosureBy(
	roots: readonly string[],
	queryPathInfo: (storePath: string) => Promise<NixValidPathInfo>
): Promise<readonly NixValidPathInfo[]> {
	const closure = new Map<string, NixValidPathInfo>();
	const pending = [...roots];

	while (pending.length > 0) {
		const storePath = pending.shift();

		if (storePath === undefined || closure.has(storePath)) {
			continue;
		}

		const info = await queryPathInfo(storePath);
		closure.set(storePath, info);

		for (const reference of info.references) {
			if (!closure.has(reference)) {
				pending.push(reference);
			}
		}
	}

	return closure
		.values()
		.toArray()
		.toSorted((left, right) => left.storePath.localeCompare(right.storePath));
}

export abstract class NixStoreError extends Error {}

export class NixStorePathNotFoundError extends NixStoreError {
	constructor(public readonly storePath: string) {
		super(`Nix store path is not registered locally: ${storePath}`);
		this.name = 'NixStorePathNotFoundError';
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
		public readonly storeDirectory: string
	) {
		super(`${path} is not inside the Nix store ${storeDirectory}`);
		this.name = 'NotInNixStoreError';
	}
}
