import { InvalidStorePathError } from './errors.ts';
import {
	type StoreDirectory,
	storeDirectorySchema,
	type StorePathBasename,
	storePathBasenameSchema,
	type StorePathHash,
	storePathHashSchema,
	storePathMaxLength,
	storePathPattern,
	type StorePathString
} from './scalars.ts';

// Pure store-path helpers, kept dependency-free so both the wire schemas and
// the `StorePath` value object share one implementation. These return
// `undefined` on failure; callers that need a hard failure add their own typed
// error on top.

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

// The store directory a path belongs to: everything before its final separator.
// A path with no directory, or one rooted directly at `/`, has none.
export function storeDirectoryOf(path: string): string | undefined {
	const separator = path.lastIndexOf('/');

	return separator <= 0 ? undefined : path.slice(0, separator);
}

export function validStorePath(path: string): string | undefined {
	// The same length bound `storePathSchema` enforces, so a shape-valid but
	// absurdly long name is refused here, at the input, not by a later parse.
	return path.length <= storePathMaxLength && storePathPattern.test(path)
		? path
		: undefined;
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
 * A retention root is a set of targets. Targets that share a store-path hash
 * collapse to the first occurrence, so repeating a path in one request does not
 * create a duplicate row downstream. Targets are expected to be validated store
 * paths; any whose hash cannot be derived are dropped.
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
	readonly storeDirectory: StoreDirectory;
	readonly basename: StorePathBasename;
	readonly hash: StorePathHash;

	// A `StorePath` is valid by construction: it parses the store directory it
	// belongs to, its basename and its hash up front, and rejects anything that
	// is not `<store directory>/<hash>-<name>`. The directory is part of the
	// value because it is an input to the path hash, so two paths naming the
	// same basename under different stores are different paths.
	constructor(value: string) {
		const directory = storeDirectoryOf(value);
		const storeDirectory =
			directory === undefined
				? undefined
				: storeDirectorySchema.safeParse(directory);
		const candidate = storePathBasename(value);
		const basename =
			candidate === undefined
				? undefined
				: storePathBasenameSchema.safeParse(candidate);

		if (!storeDirectory?.success || !basename?.success) {
			throw new InvalidStorePathError(value);
		}

		this.value = value;
		this.storeDirectory = storeDirectory.data;
		this.basename = basename.data;
		// A validated basename is `<32-char hash>-<name>`, so its leading hash
		// always satisfies the hash schema.
		this.hash = storePathHashSchema.parse(
			basename.data.slice(0, basename.data.indexOf('-'))
		);
	}
}
