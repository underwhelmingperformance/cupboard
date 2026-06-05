import type { RetentionPolicyScope } from '@cupboard/protocol/retention';

export interface RetentionPolicy {
	readonly scope: RetentionPolicyScope;
	readonly pattern: string;
	readonly ttlSeconds: number;
}

interface RootTarget {
	readonly cache: string;
	readonly name: string;
}

function matches(policy: RetentionPolicy, root: RootTarget): boolean {
	return policy.scope === 'cache'
		? policy.pattern === root.cache
		: root.name.startsWith(policy.pattern);
}

// A root-name-prefix policy targets specific roots, so it is more specific than
// a cache-wide policy; among prefixes the longer pattern wins.
function specificity(policy: RetentionPolicy): number {
	return policy.scope === 'root-name-prefix' ? policy.pattern.length : -1;
}

/**
 * The most specific policy matching a root, or `undefined` when none applies. A
 * matching name prefix beats a cache-wide policy, and a longer prefix beats a
 * shorter one.
 */
export function mostSpecificPolicy(
	policies: readonly RetentionPolicy[],
	root: RootTarget
): RetentionPolicy | undefined {
	return policies
		.filter((policy) => matches(policy, root))
		.toSorted((left, right) => specificity(right) - specificity(left))
		.at(0);
}
