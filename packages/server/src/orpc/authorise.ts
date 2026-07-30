import {
	type CacheSelector,
	cacheSelectorSchema,
	type RootName,
	rootNameSchema,
	selectorForCache,
	type StoredCache,
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

/** Resolves the cache a pending upload or attestation row was opened against. */
export type PendingCacheResolver = (
	id: string
) => Promise<StoredCache | undefined>;

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
	// A declared resource field was present in the input but failed to validate, so
	// it names no concrete grant and only a wildcard can cover the request.
	readonly unresolved: boolean;
	// A pending-row resource whose row was not found, with whether its absence
	// must deny.
	readonly pendingMissing: false | { readonly missingDenies: boolean };
}

async function resolveResource(
	spec: ResourceSpec | undefined,
	input: unknown,
	pendingCache: PendingCacheResolver
): Promise<ResolvedResource> {
	if (spec === undefined) {
		return { resource: {}, unresolved: false, pendingMissing: false };
	}

	const resource: {
		cache?: CacheSelector;
		root?: RootName;
		tenant?: TenantId;
	} = {};
	let isUnresolved = false;
	let pendingMissing: ResolvedResource['pendingMissing'] = false;

	if (spec.cache !== undefined) {
		if ('pending' in spec.cache) {
			const id = inputField(input, 'id');
			const cache = id === undefined ? undefined : await pendingCache(id);

			if (cache === undefined) {
				pendingMissing = { missingDenies: spec.cache.missingDenies !== false };
			} else {
				resource.cache = selectorForCache(cache);
			}
		} else {
			// A malformed selector names no concrete grant, so a scoped token is
			// refused while a wildcard still covers; the route's own input validation
			// renders the malformed name as a 400.
			const selector = inputField(input, spec.cache.field);
			const parsed =
				selector === undefined
					? undefined
					: cacheSelectorSchema.safeParse(selector).data;

			if (selector !== undefined && parsed === undefined) {
				isUnresolved = true;
			} else {
				resource.cache = parsed;
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

// Whether any grant authorises the operation on some resource at all, ignoring
// which one. The fallback for a benign read whose pending row has settled away:
// the holder of the operation may still poll it, but a token that never held it
// cannot.
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

// A wildcard grant carries no resource and covers every operation on every
// resource, so it is the only grant that can cover a request whose resource
// failed to validate.
function hasWildcard(grants: AccessClaims['grants']): boolean {
	return grants.some((grant) => grant.type === 'cupboard_wildcard');
}

/**
 * Authorise a request: the operation the procedure declares must be covered by
 * the token's grants on the resource it acts on. A procedure with no `requires`
 * is denied, so a missing declaration fails closed.
 */
export async function authoriseRequest(
	claims: AccessClaims,
	meta: AuthzMeta,
	input: unknown,
	pendingCache: PendingCacheResolver
): Promise<void> {
	if (meta.requires === undefined) {
		throw new InsufficientScopeError();
	}

	const { resource, unresolved, pendingMissing } = await resolveResource(
		meta.resource,
		input,
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
 * Authorise the run root a negotiate binds: `root:attach` must be covered on
 * the named cache and root, by action membership and the grant's root
 * selector, exactly as a root write's route authorisation covers `root:set`.
 * The decision is taken at negotiate, before any upload is planned; the commit
 * socket inherits the binding, so no later frame carries a root to re-check.
 */
export function authoriseAttachRoot(
	claims: AccessClaims,
	cache: CacheSelector,
	root: RootName
): void {
	if (!isCoveredByToken(claims.grants, 'root:attach', { cache, root })) {
		throw new InsufficientScopeError();
	}
}
