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
	readonly root?: string;
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
		}
	]);
}
