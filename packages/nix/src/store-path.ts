import {
	InvalidStorePathBasenameError,
	InvalidStorePathError
} from './errors.ts';
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
	constructor(public readonly value: string) {
		if (!value.startsWith('/nix/store/')) {
			throw new InvalidStorePathError(value);
		}
	}

	static basename(value: string): StorePathBasename {
		return new StorePath(value).basename;
	}

	static hash(value: string): StorePathHash {
		return new StorePath(value).hash;
	}

	static referenceBasenames(
		references: readonly string[]
	): StorePathBasename[] {
		return references
			.map((reference) => StorePath.basename(reference))
			.toSorted();
	}

	get basename(): StorePathBasename {
		const basename = storePathBasename(this.value);
		const parsed =
			basename === undefined
				? undefined
				: storePathBasenameSchema.safeParse(basename);

		if (!parsed?.success) {
			throw new InvalidStorePathError(this.value);
		}

		return parsed.data;
	}

	get hash(): StorePathHash {
		const hash = storePathHashOf(this.value);
		const parsed =
			hash === undefined ? undefined : storePathHashSchema.safeParse(hash);

		if (!parsed?.success) {
			throw new InvalidStorePathBasenameError(this.basename);
		}

		return parsed.data;
	}
}
