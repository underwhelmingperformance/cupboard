import { type ReplaySafety } from '@cupboard/shared/retry';
import { oc } from '@orpc/contract';

import { type Operation } from '../grants.ts';

/**
 * Specifies how the authoriser obtains a resource: from the cache the request
 * path selected, from an input field, or from the pending upload or attestation
 * the request addresses.
 *
 * A missing pending row denies access by default, which makes commit and attach
 * fail closed. Benign reads such as upload status set `missingDenies: false`;
 * an authorised caller can then receive the normal `absent` result after the
 * pending row is removed.
 */
export type ResourceLocation =
	| { readonly fromPath: true }
	| { readonly field: string }
	| { readonly pending: true; readonly missingDenies?: boolean };

export interface ResourceSpec {
	readonly cache?: ResourceLocation;
	readonly root?: ResourceLocation;
	readonly tenant?: ResourceLocation;
}

/**
 * Declares the required operation, resource locations, and maintenance effect
 * for a procedure. The server authoriser reads this metadata directly from the
 * contract. Although `requires` is optional in the type, every procedure must
 * set it. The authoriser denies a procedure that omits the declaration.
 */
export interface AuthzMeta {
	readonly requires?: Operation;
	readonly resource?: ResourceSpec;
	readonly maintenance?: boolean;
	readonly replaySafety?: ReplaySafety;
}

/**
 * The base contract for authenticated procedures. It declares the shared
 * authorisation errors, and each procedure adds its required operation.
 */
export const baseProcedure = oc
	.$meta<AuthzMeta>({ replaySafety: 'replay-unsafe' })
	.errors({
		UNAUTHORIZED: {},
		FORBIDDEN: {}
	});
