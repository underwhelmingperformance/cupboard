import {
	cacheNameSchema,
	type CacheScope,
	rootNameSchema
} from '@cupboard/nix-store/scalars';
import { isDeepEqual } from '@cupboard/protocol/deep-equal';
import { isGrantPermittedByRule } from '@cupboard/protocol/grant-match';
import {
	type AuthorizationDetail,
	isOperationPermittedAtIssuance,
	type PermittedGrant
} from '@cupboard/protocol/grants';
import type { OidcTrustSummary } from '@cupboard/protocol/oidc';

type CacheGrant = Extract<PermittedGrant, { type: 'cupboard_cache' }>;

// Every token that a rule accepts has the rule's exact claim values, so a
// template that uses only those claims makes the same name for every token.
function exactClaims(rule: OidcTrustSummary): Record<string, string> {
	return Object.fromEntries(
		Object.entries(rule.claims).filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string'
		)
	);
}

function cacheScope(grant: CacheGrant): CacheScope | undefined {
	const binding = grant.resources.cache;

	if (binding.kind === 'default') {
		return { kind: 'default' };
	}

	const name = cacheNameSchema.safeParse(binding.exact).data;

	return name === undefined ? undefined : { kind: 'named', name };
}

/**
The token request with the operations, cache and root of `grant`, when its
cache and root are fixed names. Returns undefined when a template or a pattern
selects either of them.
*/
function cacheRequest(grant: CacheGrant): AuthorizationDetail | undefined {
	const cache = cacheScope(grant);

	if (cache === undefined) {
		return undefined;
	}

	const rootBinding = grant.resources.root;

	if (rootBinding === undefined) {
		return { type: 'cupboard_cache', actions: grant.actions, cache };
	}

	const root = rootNameSchema.safeParse(rootBinding.exact).data;

	return root === undefined
		? undefined
		: { type: 'cupboard_cache', actions: grant.actions, cache, root };
}

// A grant whose resources come from templates or patterns has no single token
// request. An existing grant covers it when the existing grant has the same
// resource bindings and includes each of its operations.
function isGrantCoveredBy(
	existing: PermittedGrant,
	grant: PermittedGrant
): boolean {
	if (existing.type === 'cupboard_wildcard') {
		return true;
	}

	if (
		grant.type === 'cupboard_wildcard' ||
		existing.type !== grant.type ||
		!isDeepEqual(
			'resources' in existing ? existing.resources : undefined,
			'resources' in grant ? grant.resources : undefined
		)
	) {
		return false;
	}

	return grant.actions.every((operation) =>
		isOperationPermittedAtIssuance(existing.actions, operation)
	);
}

/**
Whether `rule` already permits everything that `grant` permits, for every
token that the rule accepts. A cache grant with fixed names is checked as the
token service checks a request. Any other grant needs an existing grant with
the same resource bindings and all of its operations, or a wildcard grant.
*/
export function isGrantPermittedForEveryToken(
	rule: OidcTrustSummary,
	grant: PermittedGrant
): boolean {
	const request =
		grant.type === 'cupboard_cache' ? cacheRequest(grant) : undefined;

	if (request !== undefined) {
		return isGrantPermittedByRule(
			rule.permittedGrants,
			request,
			exactClaims(rule)
		);
	}

	return rule.permittedGrants.some((existing) =>
		isGrantCoveredBy(existing, grant)
	);
}
