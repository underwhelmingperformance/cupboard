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
	 * The run root the push binds at negotiate. Attaching a path to a run root
	 * retains it, so the run root needs its own grant with its own root
	 * selector. The request therefore includes a second cache grant on the same
	 * cache, scoped to the run root: a run root and a target root are different
	 * roots with different lifetimes.
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
	 * Present for a single root's target listing (`root targets`), absent for a
	 * cache-wide listing (`root list`). The resource a listing route declares
	 * includes a root only when the route names one, and a grant with no root
	 * covers only a resource with no root.
	 */
	readonly root?: RootName;
}

export interface AttestAttachGrantIntent {
	readonly cacheSelector: string;
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

/**
 * The authority `attest attach` requests: `attestation:negotiate` and
 * `attestation:attach` on the target cache, plus `upload:negotiate`, which
 * issues the credential the bundle bytes are staged under and the signed push
 * id the attestation negotiate names. The grant includes no commit, status or
 * root operation, so the exchanged token can attach bundles to paths the cache
 * already serves but can never publish a path or change retention.
 */
export function attestAttachAuthorizationDetails(
	intent: AttestAttachGrantIntent
): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			actions: ['upload:negotiate', ...attestActions],
			cache: intent.cacheSelector
		}
	]);
}

/**
The root-scoped authority a CI preflight needs to retain an existing path.
*/
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
 * The read-only authority needed by a CI read of a cache's roots, or of one
 * root's targets: exactly `root:list`, never `root:set`, so a plan job's
 * exchanged token can read a root's reconciled list but cannot refresh
 * retention unless it separately holds `root:set`.
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
 * already-published path without uploading bytes or using any broader upload
 * operation.
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
