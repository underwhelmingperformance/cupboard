import {
	cacheNameSchema,
	type CacheScope,
	type RootName,
	rootNameSchema,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { type AuthzMeta, type ResourceSpec } from '@cupboard/protocol/contract';
import {
	isCoveredByToken,
	type Operation,
	type ResourceRequest
} from '@cupboard/protocol/grants';
import { z } from 'zod';

import { type AccessClaims } from '../auth/auth.ts';
import { InsufficientScopeError } from '../errors.ts';

/**
 * Returns the cache recorded by a pending upload or attestation, or `undefined`
 * after the pending row has settled or expired.
 */
export type PendingCacheResolver = (
	id: string
) => Promise<CacheScope | undefined>;

/**
 * A resolver for callers with no pending rows to consult, such as the control
 * plane and the commit-session guard. It always reports absence.
 */
export const noPendingCache: PendingCacheResolver = () =>
	Promise.resolve(undefined);

function inputField(input: unknown, name: string): string | undefined {
	const direct = z.looseObject({ [name]: z.string() }).safeParse(input);

	if (direct.success) {
		return direct.data[name];
	}

	// A detailed input structure (a DELETE carrying a query) nests path params.
	const nested = z
		.looseObject({ params: z.looseObject({ [name]: z.string() }) })
		.safeParse(input);

	return nested.success ? nested.data.params[name] : undefined;
}

interface ResolvedResource {
	readonly resource: ResourceRequest;
	// Only a wildcard grant can cover a resource field that failed validation.
	readonly unresolved: boolean;
	// Records whether an absent pending row must deny the request.
	readonly pendingMissing: false | { readonly missingDenies: boolean };
}

async function resolveResource(
	spec: ResourceSpec | undefined,
	input: unknown,
	pathCache: CacheScope,
	pendingCache: PendingCacheResolver
): Promise<ResolvedResource> {
	if (spec === undefined) {
		return { resource: {}, unresolved: false, pendingMissing: false };
	}

	const resource: {
		cache?: CacheScope;
		root?: RootName;
		tenant?: TenantId;
	} = {};
	let isUnresolved = false;
	let pendingMissing: ResolvedResource['pendingMissing'] = false;

	if (spec.cache !== undefined) {
		if ('fromPath' in spec.cache) {
			resource.cache = pathCache;
		} else if ('pending' in spec.cache) {
			const id = inputField(input, 'id');
			const cache = id === undefined ? undefined : await pendingCache(id);

			if (cache === undefined) {
				pendingMissing = { missingDenies: spec.cache.missingDenies !== false };
			} else {
				resource.cache = cache;
			}
		} else {
			// A scoped grant cannot cover an invalid cache name. A wildcard can,
			// although route validation will still return 400 for the input.
			const name = inputField(input, spec.cache.field);
			const parsed =
				name === undefined ? undefined : cacheNameSchema.safeParse(name).data;

			if (name !== undefined && parsed === undefined) {
				isUnresolved = true;
			} else {
				resource.cache =
					parsed === undefined ? undefined : { kind: 'named', name: parsed };
			}
		}
	}

	if (spec.root !== undefined && 'field' in spec.root) {
		const raw = inputField(input, spec.root.field);
		const parsed =
			raw === undefined ? undefined : rootNameSchema.safeParse(raw).data;

		if (raw !== undefined && parsed === undefined) {
			isUnresolved = true;
		} else {
			resource.root = parsed;
		}
	}

	if (spec.tenant !== undefined && 'field' in spec.tenant) {
		const raw = inputField(input, spec.tenant.field);
		const parsed =
			raw === undefined ? undefined : tenantIdSchema.safeParse(raw).data;

		if (raw !== undefined && parsed === undefined) {
			isUnresolved = true;
		} else {
			resource.tenant = parsed;
		}
	}

	return { resource, unresolved: isUnresolved, pendingMissing };
}

// When a benign read outlives its pending row, allow polling only if the token
// authorises that operation for some resource.
function hasOperation(
	grants: AccessClaims['grants'],
	operation: Operation
): boolean {
	return grants.some(
		(grant) =>
			grant.type === 'cupboard_wildcard' ||
			(grant.actions as readonly Operation[]).includes(operation)
	);
}

// Only a wildcard grant can cover a request whose resource failed validation.
function hasWildcard(grants: AccessClaims['grants']): boolean {
	return grants.some((grant) => grant.type === 'cupboard_wildcard');
}

/**
 * Requires the token to authorise the procedure's operation for its resolved
 * resource. A procedure without a `requires` declaration is denied.
 */
export async function authoriseRequest(
	claims: AccessClaims,
	meta: AuthzMeta,
	input: unknown,
	pathCache: CacheScope,
	pendingCache: PendingCacheResolver
): Promise<void> {
	if (meta.requires === undefined) {
		throw new InsufficientScopeError();
	}

	const { resource, unresolved, pendingMissing } = await resolveResource(
		meta.resource,
		input,
		pathCache,
		pendingCache
	);

	if (pendingMissing !== false) {
		if (
			pendingMissing.missingDenies ||
			!hasOperation(claims.grants, meta.requires)
		) {
			throw new InsufficientScopeError();
		}

		return;
	}

	if (unresolved) {
		if (!hasWildcard(claims.grants)) {
			throw new InsufficientScopeError();
		}

		return;
	}

	if (!isCoveredByToken(claims.grants, meta.requires, resource)) {
		throw new InsufficientScopeError();
	}
}

/**
 * Requires `root:attach` authority for the cache and run root selected during
 * negotiation. The commit session inherits this binding, so later frames do
 * not repeat the root name.
 */
export function authoriseAttachRoot(
	claims: AccessClaims,
	cache: CacheScope,
	root: RootName
): void {
	if (!isCoveredByToken(claims.grants, 'root:attach', { cache, root })) {
		throw new InsufficientScopeError();
	}
}
