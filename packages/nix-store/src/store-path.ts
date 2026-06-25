import { InvalidStorePathError } from './errors.ts';
import {
	type StorePathBasename,
	storePathBasenameSchema,
	type StorePathHash,
	storePathHashSchema,
	type StorePathString
} from './scalars.ts';

// Pure store-path derivations, kept dependency-free so both the wire schemas
// and the `StorePath` value object share one implementation. These return
// `undefined` rather than throwing; callers that want a hard failure layer
// their own typed error on top.

// Order strings by UTF-16 code unit, matching the default `Array#sort` order.
export function byCodeUnit(a: string, b: string): number {
	if (a < b) {
		return -1;
	}

	if (a > b) {
		return 1;
	}

	return 0;
}

export function storePathBasename(path: string): string | undefined {
	const basename = path.split('/').at(-1);

	return basename === undefined || basename === '' ? undefined : basename;
}

export function storePathHashOf(path: string): string | undefined {
	const basename = storePathBasename(path);

	if (basename === undefined) {
		return undefined;
	}

	const separator = basename.indexOf('-');

	return separator === -1 ? undefined : basename.slice(0, separator);
}

export interface ResolvedRootTarget {
	readonly storePathHash: StorePathHash;
	readonly storePath: StorePathString;
}

/**
 * A retention root is a set: collapses targets sharing a store-path hash to the
 * first occurrence, so a repeated path is idempotent rather than a primary-key
 * clash downstream. Targets are expected to be validated store paths; any whose
 * hash cannot be derived are dropped.
 */
export function resolveRootTargets(
	targets: readonly StorePathString[]
): readonly ResolvedRootTarget[] {
	const resolved: ResolvedRootTarget[] = [];
	const seen = new Set<string>();

	for (const storePath of targets) {
		const hash = storePathHashOf(storePath);

		if (hash === undefined || seen.has(hash)) {
			continue;
		}

		const storePathHash = storePathHashSchema.safeParse(hash);

		if (!storePathHash.success) {
			continue;
		}

		seen.add(hash);
		resolved.push({ storePathHash: storePathHash.data, storePath });
	}

	return resolved;
}

export class StorePath {
	static basename(value: string): StorePathBasename {
		const storePath = new StorePath(value);
		return storePath.basename;
	}

	static hash(value: string): StorePathHash {
		const storePath = new StorePath(value);
		return storePath.hash;
	}

	static referenceBasenames(
		references: readonly string[]
	): StorePathBasename[] {
		return references
			.map((reference) => this.basename(reference))
			.toSorted(byCodeUnit);
	}

	readonly value: string;
	readonly basename: StorePathBasename;
	readonly hash: StorePathHash;

	// A `StorePath` is valid by construction: it parses its basename and hash up
	// front and rejects anything that is not `/nix/store/<hash>-<name>`, so every
	// instance carries those derived values rather than re-deriving them lazily.
	constructor(value: string) {
		if (!value.startsWith('/nix/store/')) {
			throw new InvalidStorePathError(value);
		}

		const candidate = storePathBasename(value);
		const basename =
			candidate === undefined
				? undefined
				: storePathBasenameSchema.safeParse(candidate);

		if (!basename?.success) {
			throw new InvalidStorePathError(value);
		}

		this.value = value;
		this.basename = basename.data;
		// A validated basename is `<32-char hash>-<name>`, so its leading hash
		// always satisfies the hash schema.
		this.hash = storePathHashSchema.parse(
			basename.data.slice(0, basename.data.indexOf('-'))
		);
	}
}
