import { type RootName } from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';

// What a push needs from a token: it always uploads, optionally attaches
// attestations, and optionally sets a retention root. The grant it requests is
// exactly this, so a CI exchange (which must name its `authorization_details`)
// receives a token confined to the one cache it pushes to.
export interface PushGrantIntent {
	readonly cacheSelector: string;
	readonly attest: boolean;
	readonly root?: RootName;
	/**
	 * The run root the push binds at negotiate. Attaching retains paths under
	 * a name, so it needs its own explicit grant on its own root selector: the
	 * request carries a second cache grant on the same cache for it, since a
	 * run root and a target root are different roots with different lifetimes.
	 */
	readonly runRoot?: RootName;
}

export interface RootEnsureGrantIntent {
	readonly cacheSelector: string;
	readonly root: RootName;
}

export interface RootListGrantIntent {
	readonly cacheSelector: string;
	/**
	 * Present for a single root's target listing (`root targets`), absent for
	 * a cache-wide listing (`root list`): the resource a listing route
	 * declares carries a root only when it names one, and a grant with no
	 * root only covers a root-free resource.
	 */
	readonly root?: RootName;
}

export interface ConfirmGrantIntent {
	readonly cacheSelector: string;
}

export interface PreviewGrantIntent {
	readonly cacheSelector: string;
}

const uploadActions = ['upload:negotiate', 'upload:status', 'upload:commit'];

const attestActions = ['attestation:negotiate', 'attestation:attach'];

/**
 * The concrete `authorization_details` a push requests: a single cache grant on
 * the target cache, carrying upload (and, when used, attestation and `root:set`)
 * operations. Built and validated client-side so a CI run asks for the least it
 * needs and no more.
 */
export function pushAuthorizationDetails(
	intent: PushGrantIntent
): AuthorizationDetails {
	const actions = [
		...uploadActions,
		...(intent.attest ? attestActions : []),
		...(intent.root === undefined ? [] : ['root:set'])
	];

	return authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			actions,
			cache: intent.cacheSelector,
			...(intent.root !== undefined && { root: intent.root })
		},
		...(intent.runRoot === undefined
			? []
			: [
					{
						type: 'cupboard_cache',
						actions: ['root:attach'],
						cache: intent.cacheSelector,
						root: intent.runRoot
					}
				])
	]);
}

/** The root-scoped authority a CI preflight needs to retain an existing path. */
export function rootEnsureAuthorizationDetails(
	intent: RootEnsureGrantIntent
): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			actions: ['root:set'],
			cache: intent.cacheSelector,
			root: intent.root
		}
	]);
}

/**
 * The read-only authority a CI read of a cache's roots, or one root's
 * targets, needs: exactly `root:list`, never `root:set`, so a plan job's
 * exchanged token can read a root's reconciled list and refresh nothing it
 * does not already hold `root:set` for separately.
 */
export function rootListAuthorizationDetails(
	intent: RootListGrantIntent
): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			actions: ['root:list'],
			cache: intent.cacheSelector,
			...(intent.root !== undefined && { root: intent.root })
		}
	]);
}

/**
 * The confirm-scoped authority `cupboard confirm` needs: exactly
 * `upload:confirm` on the target cache, never `upload:negotiate` or
 * `upload:commit`, so the exchanged token can extend retention on an
 * already-published path without uploading bytes or reaching a broader
 * upload operation.
 */
export function confirmAuthorizationDetails(
	intent: ConfirmGrantIntent
): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			actions: ['upload:confirm'],
			cache: intent.cacheSelector
		}
	]);
}

/**
 * The preview-scoped authority a `--dry-run` push needs: exactly
 * `upload:preview` on the target cache, never `upload:negotiate` or
 * `upload:commit`, so a dry run's exchanged token cannot stage or commit an
 * upload even if the client asked it to.
 */
export function previewAuthorizationDetails(
	intent: PreviewGrantIntent
): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			actions: ['upload:preview'],
			cache: intent.cacheSelector
		}
	]);
}
