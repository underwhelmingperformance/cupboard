import {
	cacheSelectorSchema,
	selectorForCache
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
export type PendingCacheResolver = (id: string) => Promise<string | undefined>;

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
		return { resource: {}, pendingMissing: false };
	}

	const resource: { cache?: string; root?: string; tenant?: string } = {};
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
			// A malformed selector is left as-is: it matches no concrete grant, so a
			// scoped token is refused, while a wildcard still covers and the route's
			// own input validation renders the malformed name as a 400.
			const selector = inputField(input, spec.cache.field);
			resource.cache =
				selector === undefined
					? undefined
					: (cacheSelectorSchema.safeParse(selector).data ?? selector);
		}
	}

	if (spec.root !== undefined && 'field' in spec.root) {
		resource.root = inputField(input, spec.root.field);
	}

	if (spec.tenant !== undefined && 'field' in spec.tenant) {
		resource.tenant = inputField(input, spec.tenant.field);
	}

	return { resource, pendingMissing };
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

	const { resource, pendingMissing } = await resolveResource(
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

	if (!isCoveredByToken(claims.grants, meta.requires, resource)) {
		throw new InsufficientScopeError();
	}
}
