import {
	cacheSelectorSchema,
	rootNameSchema
} from '@cupboard/nix-store/scalars';

import { applyTransform } from './capture.ts';
import {
	type AuthorizationDetail,
	isOperationPermittedAtIssuance,
	type Operation,
	type PermittedGrant,
	type Substitution
} from './grants.ts';
import { type OidcClaims } from './oidc-trust-match.ts';

// A trust rule's resource bindings are evaluated against the verified claims to
// decide whether a requested grant is permitted. Rendering fails closed: a
// missing claim, a capture that does not match, or a rendered value that fails
// its grammar yields no value, so the requested grant is refused.

type CacheBinding = Extract<
	PermittedGrant,
	{ type: 'cupboard_cache' }
>['resources']['cache'];
type RootBinding = NonNullable<
	Extract<PermittedGrant, { type: 'cupboard_cache' }>['resources']['root']
>;
type TenantBinding = Extract<
	PermittedGrant,
	{ type: 'cupboard_tenant' }
>['resources']['tenant'];

// Only string claims can render into a resource value; a numeric or structured
// claim never satisfies a template by coincidence.
function stringClaims(claims: OidcClaims): Record<string, string> {
	const rendered: Record<string, string> = {};

	for (const [name, value] of Object.entries(claims)) {
		if (typeof value === 'string') {
			rendered[name] = value;
		}
	}

	return rendered;
}

const placeholderPattern = /\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

function renderTemplate(
	template: string,
	substitutions: Record<string, Substitution> | undefined,
	claims: Record<string, string>
): string | undefined {
	let rendered = '';
	let lastIndex = 0;

	// Stitch the literal spans and the rendered substitutions together. A missing
	// substitution or a transform that throws fails the whole render: the caller
	// reads `undefined` and refuses the grant.
	for (const match of template.matchAll(placeholderPattern)) {
		const name = match[1];
		const substitution = name === undefined ? undefined : substitutions?.[name];

		if (substitution === undefined) {
			return undefined;
		}

		let value: string;

		try {
			value = applyTransform(substitution, claims);
		} catch {
			return undefined;
		}

		rendered += template.slice(lastIndex, match.index) + value;
		lastIndex = match.index + match[0].length;
	}

	return rendered + template.slice(lastIndex);
}

// The raw value a template-or-exact binding names, before grammar validation.
function renderBindingValue(
	binding: {
		readonly exact?: string;
		readonly equalsTemplate?: string;
		readonly substitutions?: Record<string, Substitution>;
	},
	claims: Record<string, string>
): string | undefined {
	if (binding.exact !== undefined) {
		return binding.exact;
	}

	if (binding.equalsTemplate !== undefined) {
		return renderTemplate(
			binding.equalsTemplate,
			binding.substitutions,
			claims
		);
	}

	return undefined;
}

function renderCache(
	binding: CacheBinding,
	claims: Record<string, string>
): string | undefined {
	const raw = renderBindingValue(binding, claims);

	if (raw === undefined) {
		return undefined;
	}

	// Render to a wire selector (a cache name or `_default`), matching the
	// selector a requested grant carries, so a rule can permit the default cache.
	return cacheSelectorSchema.safeParse(raw).data;
}

function renderRoot(
	binding: RootBinding,
	cache: string,
	claims: Record<string, string>
): string | undefined {
	// The relational binding ties the root to the cache the same grant resolved.
	const raw =
		binding.equalsResource === 'cache'
			? cache
			: renderBindingValue(binding, claims);

	if (raw === undefined) {
		return undefined;
	}

	return rootNameSchema.safeParse(raw).data;
}

function renderTenant(
	binding: TenantBinding,
	claims: Record<string, string>
): string | undefined {
	return renderBindingValue(binding, claims);
}

// A requested root is within a granted root selector: an exact name, or any name
// beneath a trailing-slash prefix. The same containment `isCoveredByToken` applies.
function isRootWithin(requested: string, granted: string): boolean {
	return granted.endsWith('/')
		? requested.startsWith(granted)
		: requested === granted;
}

function isActionsPermittedAtIssuance(
	requested: readonly Operation[],
	permitted: readonly Operation[]
): boolean {
	return requested.every((action) =>
		isOperationPermittedAtIssuance(permitted, action)
	);
}

function isGrantPermitted(
	permitted: PermittedGrant,
	requested: AuthorizationDetail,
	claims: Record<string, string>
): boolean {
	if (permitted.type === 'cupboard_wildcard') {
		return true;
	}

	if (permitted.type !== requested.type) {
		return false;
	}

	if (!isActionsPermittedAtIssuance(requested.actions, permitted.actions)) {
		return false;
	}

	switch (permitted.type) {
		case 'cupboard_domain':
		case 'cupboard_control': {
			// Resource-free: the actions subset is the whole test.
			return true;
		}
		case 'cupboard_tenant': {
			const tenant = renderTenant(permitted.resources.tenant, claims);

			return (
				tenant !== undefined &&
				requested.type === 'cupboard_tenant' &&
				requested.tenant === tenant
			);
		}
		case 'cupboard_cache': {
			if (requested.type !== 'cupboard_cache') {
				return false;
			}

			const cache = renderCache(permitted.resources.cache, claims);

			if (cache === undefined || requested.cache !== cache) {
				return false;
			}

			if (requested.root === undefined) {
				return true;
			}

			if (permitted.resources.root === undefined) {
				return false;
			}

			const root = renderRoot(permitted.resources.root, cache, claims);

			return root !== undefined && isRootWithin(requested.root, root);
		}
	}
}

/**
 * Whether the rule permits the requested concrete grant, evaluating the rule's
 * bindings against the verified claims. The operations must be a subset of a
 * permitted grant's, and each requested resource must fall within what that
 * grant's bindings render. A wildcard permitted grant permits anything.
 */
export function isGrantPermittedByRule(
	permittedGrants: readonly PermittedGrant[],
	requested: AuthorizationDetail,
	claims: OidcClaims
): boolean {
	const rendered = stringClaims(claims);

	return permittedGrants.some((permitted) =>
		isGrantPermitted(permitted, requested, rendered)
	);
}
