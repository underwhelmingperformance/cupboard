import {
	cacheNameSchema,
	type CacheScope,
	isSameCacheScope,
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

// Grant bindings resolve resource names only from string-valued claims. Callers
// that issue authority must verify the claims first. Resolution fails closed:
// an absent claim, a capture that does not match, or a rendered value outside
// the resource grammar prevents the binding from permitting the request.

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
): CacheScope | undefined {
	if (binding.kind === 'default') {
		return { kind: 'default' };
	}

	const raw = renderBindingValue(binding, claims);

	if (raw === undefined) {
		return undefined;
	}

	const name = cacheNameSchema.safeParse(raw).data;

	return name === undefined ? undefined : { kind: 'named', name };
}

function renderRoot(
	binding: RootBinding,
	claims: Record<string, string>
): string | undefined {
	const raw = renderBindingValue(binding, claims);

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

// A trailing slash grants every root below the prefix. Without it, the names
// must match exactly. Token authorisation uses the same containment rule.
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

			if (cache === undefined || !isSameCacheScope(requested.cache, cache)) {
				return false;
			}

			if (
				requested.managedPolicy !== undefined &&
				requested.managedPolicy !== permitted.resources.managedPolicy
			) {
				return false;
			}

			if (requested.root === undefined) {
				return true;
			}

			if (permitted.resources.root === undefined) {
				return false;
			}

			const root = renderRoot(permitted.resources.root, claims);

			return root !== undefined && isRootWithin(requested.root, root);
		}
	}
}

/**
 * A rule permits a concrete grant only when it includes every requested
 * operation and each resource binding resolves to the requested resource. A
 * wildcard permitted grant permits every request.
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

/**
 * Resolves one requested grant against a stored rule. A managed policy remains
 * server-selected when the caller requests `cache:provision`: the stored rule
 * supplies the policy identity after its cache template and claims match.
 */
export function resolveGrantPermittedByRule(
	permittedGrants: readonly PermittedGrant[],
	requested: AuthorizationDetail,
	claims: OidcClaims
): AuthorizationDetail | undefined {
	const rendered = stringClaims(claims);

	for (const permitted of permittedGrants) {
		if (!isGrantPermitted(permitted, requested, rendered)) {
			continue;
		}

		if (
			requested.type === 'cupboard_cache' &&
			permitted.type === 'cupboard_cache' &&
			permitted.resources.managedPolicy !== undefined
		) {
			return {
				...requested,
				managedPolicy: permitted.resources.managedPolicy
			};
		}

		return requested;
	}

	return undefined;
}
