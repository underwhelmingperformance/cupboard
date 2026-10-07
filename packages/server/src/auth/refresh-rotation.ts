import {
	type AuthorizationDetails,
	isAuthorizationDetailCovered
} from '@cupboard/protocol/grants';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';

import { refreshTokenRetryGraceMs } from './auth.ts';
import { type AuthenticatedRefreshAuthority } from './refresh-credential.ts';

/**
 * Authenticating against this hash always fails. A presented credential with
 * an unknown member ID is hashed like one with a known ID, so the response time
 * does not show whether the member exists.
 */
export const unknownMemberCredentialHash = '0'.repeat(64);

/**
The stored fields of a refresh family that a credential must agree with.
*/
export interface RefreshFamilyState {
	readonly id: string;
	readonly expiresAt: IsoTimestamp;
}

/**
The stored fields of a refresh member that a credential must agree with.
*/
export interface RefreshMemberState {
	readonly id: string;
	readonly familyId: string;
	readonly generation: number;
}

/**
 * Whether two sets of grants cover each other. A retry must request grants
 * equivalent to those in the successor credential.
 */
export function hasSameAuthority(
	left: AuthorizationDetails,
	right: AuthorizationDetails
): boolean {
	return (
		left.every((detail) => isAuthorizationDetailCovered(right, detail)) &&
		right.every((detail) => isAuthorizationDetailCovered(left, detail))
	);
}

/**
 * Whether a successor member created at `createdAt` can still be returned to a
 * retry of the credential that it replaced.
 */
export function isWithinRefreshRetryGrace(
	createdAt: IsoTimestamp,
	now: IsoTimestamp
): boolean {
	const elapsedMs = Date.parse(now) - Date.parse(createdAt);

	return elapsedMs >= 0 && elapsedMs <= refreshTokenRetryGraceMs;
}

/**
Whether an authenticated authority describes the stored family and member.
*/
export function isRefreshStateMatching(
	authority: AuthenticatedRefreshAuthority,
	family: RefreshFamilyState,
	member: RefreshMemberState
): boolean {
	return (
		authority.familyId === family.id &&
		member.familyId === family.id &&
		authority.memberId === member.id &&
		authority.generation === member.generation &&
		authority.expiresAt === family.expiresAt
	);
}
