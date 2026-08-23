import type { StoredCache } from '@cupboard/nix-store/scalars';
import type { RetentionPolicyScope } from '@cupboard/protocol/retention';

export interface RetentionPolicy {
	readonly scope: RetentionPolicyScope;
	readonly pattern: string;
	readonly ttlSeconds: number;
}

interface RootTarget {
	readonly cache: StoredCache;
	readonly name: string;
}

function isMatch(policy: RetentionPolicy, root: RootTarget): boolean {
	return policy.scope === 'cache'
		? policy.pattern === root.cache
		: root.name.startsWith(policy.pattern);
}

function specificity(policy: RetentionPolicy): number {
	return policy.scope === 'root-name-prefix' ? policy.pattern.length : -1;
}

/**
 * Selects a matching root-name prefix before a cache-wide policy. When several
 * prefixes match, selects the longest one. Returns `undefined` when no policy
 * matches.
 */
export function mostSpecificPolicy(
	policies: readonly RetentionPolicy[],
	root: RootTarget
): RetentionPolicy | undefined {
	return policies
		.filter((policy) => isMatch(policy, root))
		.toSorted((left, right) => specificity(right) - specificity(left))
		.at(0);
}
