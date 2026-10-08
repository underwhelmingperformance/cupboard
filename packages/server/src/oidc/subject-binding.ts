import { type OidcIssuer } from '@cupboard/protocol/oidc';
import { type VerifiedOidcClaims } from '@cupboard/protocol/oidc-trust-match';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	isCanonicalTarget,
	subjectBindingNonce
} from '@cupboard/protocol/subject-binding';

import {
	consumedSubjectNonceRetentionSeconds,
	subjectNonceMaxAgeSeconds
} from '../auth/auth.ts';
import { SubjectTokenUnboundError } from '../errors.ts';

import { isAudienceBound } from './audience-binding.ts';
import { type InboundTokenLimits } from './inbound-verifier.ts';

/**
 * The binding parameters of a token request, as the form schemas parse them.
 */
export interface SubjectBindingParameters {
	readonly cupboard_binding_seed?: string | undefined;
	readonly cupboard_binding_targets?: readonly string[] | undefined;
}

/**
 * A nonce to record as consumed, and the instant at which the server may
 * delete the record.
 */
export interface SubjectNonce {
	readonly nonce: string;
	readonly expiresAt: IsoTimestamp;
}

export type SubjectBinding =
	| { readonly kind: 'nonce-bound'; readonly nonce: SubjectNonce }
	| { readonly kind: 'audience-bound' };

/**
 * The verification limit for a request. A request with binding parameters is
 * either nonce-bound or refused, so its token must also be at most
 * {@link subjectNonceMaxAgeSeconds} old.
 */
export function subjectTokenLimits(
	parameters: SubjectBindingParameters
): InboundTokenLimits {
	return hasBindingParameters(parameters)
		? { maxTokenAgeSeconds: subjectNonceMaxAgeSeconds }
		: {};
}

/**
 * Classifies a verified subject token for the server whose identity is
 * `target`, and refuses a token that is not bound to `target` with
 * `SubjectTokenUnboundError`. Without binding parameters, the token's audience
 * must be `target`, whether or not the token has a `nonce` claim. With them,
 * every target must be a canonical URL, the targets must include `target`, and
 * the token's `nonce` claim must equal their hash with the seed.
 */
export async function subjectBinding(
	claims: VerifiedOidcClaims,
	target: OidcIssuer,
	parameters: SubjectBindingParameters
): Promise<SubjectBinding> {
	if (!hasBindingParameters(parameters)) {
		if (!isAudienceBound(claims, target)) {
			throw new SubjectTokenUnboundError();
		}

		return { kind: 'audience-bound' };
	}

	const seed = parameters.cupboard_binding_seed;
	const targets = parameters.cupboard_binding_targets;

	if (
		seed === undefined ||
		targets === undefined ||
		targets.some((entry) => !isCanonicalTarget(entry)) ||
		!targets.includes(target) ||
		typeof claims.nonce !== 'string' ||
		claims.nonce !== (await subjectBindingNonce(targets, seed))
	) {
		throw new SubjectTokenUnboundError();
	}

	return {
		kind: 'nonce-bound',
		nonce: {
			nonce: claims.nonce,
			expiresAt: isoTimestamp(
				new Date(Date.now() + consumedSubjectNonceRetentionSeconds * 1000)
			)
		}
	};
}

function hasBindingParameters(parameters: SubjectBindingParameters): boolean {
	return (
		parameters.cupboard_binding_seed !== undefined ||
		parameters.cupboard_binding_targets !== undefined
	);
}
