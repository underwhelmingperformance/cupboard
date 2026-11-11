import { type ReplaySafety } from '@cupboard/shared/retry';
import { oc } from '@orpc/contract';

import { type Operation } from '../grants.ts';

/**
Specifies how the authoriser obtains a resource: from the request path, from
an input field, or from the pending upload or attestation in the request.

A missing pending row denies access by default. A procedure can set
`missingDenies: false` so a caller with the required operation can receive
the normal missing result after the pending row is removed.
*/
export type ResourceLocation =
	| { readonly fromPath: true }
	| { readonly field: string }
	| { readonly pending: true; readonly missingDenies?: boolean };

/**
A procedure that acts on several roots lists them in an input array. The
authoriser reads each root from `field` of every element of the array named
`eachIn`, and the token must authorise every one of them.
*/
export type RootLocation =
	ResourceLocation | { readonly eachIn: string; readonly field: string };

export interface ResourceSpec {
	readonly cache?: ResourceLocation;
	readonly root?: RootLocation;
	readonly tenant?: ResourceLocation;
}

/**
Declares the required operation, resource locations, and maintenance effect
for a procedure. The server authoriser reads this metadata directly from the
contract. Although `requires` is optional in the type, every procedure must
set it. The authoriser denies a procedure that omits the declaration.
*/
export interface AuthzMeta {
	readonly acceptsControlDatabaseValidationSecret?: true;
	readonly requires?: Operation;
	readonly resource?: ResourceSpec;
	readonly maintenance?: Maintenance;
	readonly replaySafety?: ReplaySafety;
}

/**
When the server reconciles maintenance eligibility after a procedure. `true`
reconciles after every call. `'when-changed'` reconciles after a call that
failed or that recorded a change of state, so a call that changed nothing
writes nothing.
*/
type Maintenance = boolean | 'when-changed';

/**
The base contract for authenticated procedures. It declares the shared
authorisation errors, and each procedure adds its required operation.
*/
export const baseProcedure = oc
	.$meta<AuthzMeta>({ replaySafety: 'replay-unsafe' })
	.errors({
		UNAUTHORIZED: {},
		FORBIDDEN: {}
	});
