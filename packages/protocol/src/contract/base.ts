import { oc } from '@orpc/contract';

import { type Operation } from '../grants.ts';

/**
 * Where the authoriser finds a resource the operation acts on: a named input
 * field, or the stored pending upload/attestation row addressed by the request.
 *
 * A pending row that no longer exists denies by default: a commit or attach
 * against a vanished upload must fail closed. A read whose answer for a missing
 * row is benign (a settled upload's status is `absent`) sets `missingDenies:
 * false`, so the holder of the operation may still poll it once it settles.
 */
export type ResourceLocation =
	| { readonly field: string }
	| { readonly pending: true; readonly missingDenies?: boolean };

/** The resources a procedure's operation is scoped by, and where each lives. */
export interface ResourceSpec {
	readonly cache?: ResourceLocation;
	readonly root?: ResourceLocation;
	readonly tenant?: ResourceLocation;
}

/**
 * The authority declaration each procedure carries once, in the contract: the
 * operation it requires, where its resources come from, and whether it mutates
 * state behind the maintenance-eligibility bookkeeping. The server's authoriser
 * reads these; neither side repeats them. `requires` is optional in the type but
 * every procedure sets it, and the authoriser denies one that does not, so a
 * forgotten declaration fails closed.
 */
export interface AuthzMeta {
	readonly requires?: Operation;
	readonly resource?: ResourceSpec;
	readonly maintenance?: boolean;
}

/**
 * The base every procedure builds on: it declares the auth failures every
 * authenticated procedure can answer. Each procedure sets its own `requires`.
 */
export const baseProcedure = oc.$meta<AuthzMeta>({}).errors({
	UNAUTHORIZED: {},
	FORBIDDEN: {}
});
