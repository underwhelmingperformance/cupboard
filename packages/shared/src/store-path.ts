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
	readonly storePathHash: string;
	readonly storePath: string;
}

/**
 * A retention root is a set: collapses targets sharing a store-path hash to the
 * first occurrence, so a repeated path is idempotent rather than a primary-key
 * clash downstream. Targets are expected to be validated store paths; any whose
 * hash cannot be derived are dropped.
 */
export function resolveRootTargets(
	targets: readonly string[]
): readonly ResolvedRootTarget[] {
	const resolved: ResolvedRootTarget[] = [];
	const seen = new Set<string>();

	for (const storePath of targets) {
		const storePathHash = storePathHashOf(storePath);

		if (storePathHash === undefined || seen.has(storePathHash)) {
			continue;
		}

		seen.add(storePathHash);
		resolved.push({ storePathHash, storePath });
	}

	return resolved;
}
