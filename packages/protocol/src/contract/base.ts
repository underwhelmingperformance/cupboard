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

/**
The stored access key that a procedure acts on.

- `{ field }`: the input field contains the id of the key. The resources are
  those that the key's grants select, and the token must authorise
  `requires` for every one of them. When no key has the id, the token must
  authorise `requires` for some resource, and the procedure reports the key
  as absent.
- `{ listed: true }`: the procedure lists keys. The token must authorise
  `requires` for some resource, and the procedure returns only the keys that
  the server's `isAccessKeyCovered` admits for that operation.
*/
export type AccessKeyLocation =
	{ readonly field: string } | { readonly listed: true };

export interface ResourceSpec {
	readonly cache?: ResourceLocation;
	readonly root?: RootLocation;
	readonly tenant?: ResourceLocation;
	readonly accessKey?: AccessKeyLocation;
}

/**
Declares a procedure that creates an access key from the caller's authority.
`grantsIn` and `expiresAtIn` give the input fields that contain the
requested grants and the requested expiry. The caller's grants must cover
every requested grant. Unless `access-key:create` covers the resource of
every requested grant, the expiry must be present and no later than the
expiry of the caller's token.
*/
export interface DerivationSpec {
	readonly grantsIn: string;
	readonly expiresAtIn: string;
}

/**
Declares the authority, resource locations, and maintenance effect for a
procedure. The server authoriser reads this metadata directly from the
contract. Every procedure declares either the operation that it `requires`
or the credential that it `derives`, and the type refuses both. oRPC builds
each procedure from an initial metadata value without either, so the type
cannot require one. A contract test checks every procedure, and the
authoriser denies a procedure that declares neither.
*/
export type AuthzMeta = AuthzMetaFields & AuthorityDeclaration;

type AuthorityDeclaration =
	| { readonly requires?: Operation; readonly derives?: never }
	| { readonly derives: DerivationSpec; readonly requires?: never };

interface AuthzMetaFields {
	readonly acceptsControlDatabaseValidationSecret?: true;
	readonly resource?: ResourceSpec;
	readonly maintenance?: Maintenance;
	readonly replaySafety?: ReplaySafety;
	readonly workBound?: WorkBound;
}

/**
What bounds the tenant object's work for one call of a tenant procedure.
`time`: the call makes a fixed number of calls with capped durations, such
as one critical section and a few D1 calls, so the Worker waits for the
response with a fixed deadline. `size`: only the size of the page or the
number of rows bounds the work, so its duration grows with the input and the
Worker waits without a deadline. Every tenant procedure declares it.
*/
export type WorkBound = 'time' | 'size';

/**
Returns the `workBound` that a procedure declares in its metadata, or
`undefined` when it declares none.
*/
export function workBoundOf(procedure: {
	readonly '~orpc': { readonly meta: unknown };
}): WorkBound | undefined {
	const { meta } = procedure['~orpc'];

	if (typeof meta !== 'object' || meta === null || !('workBound' in meta)) {
		return undefined;
	}

	return meta.workBound === 'time' || meta.workBound === 'size'
		? meta.workBound
		: undefined;
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
