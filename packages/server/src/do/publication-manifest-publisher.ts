import type { CacheScope } from '@cupboard/nix-store/scalars';
import type { AuthorizationDetails } from '@cupboard/protocol/grants';
import type {
	PublicationEnsureRequest,
	PublicationOperationId,
	PublicationResultIdentity
} from '@cupboard/protocol/publication-manifests';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';

import type { ResolvedCache } from '../db/cache.ts';

import type { PublicationManifestAuthoritySnapshot } from './publication-manifest-authority.ts';

export interface PublicationManifestPublication {
	readonly operationId: PublicationOperationId;
	readonly destination: CacheScope;
	readonly request: PublicationEnsureRequest;
	readonly grants: AuthorizationDetails;
	readonly source: PublicationManifestAuthoritySnapshot;
}

/**
Required normal-publication adapter, not an alternate commit implementation.

admit pins the intent and either proves an exact healthy destination result or
starts its ordinary publication. Only ordinary publication admission may
register an absent destination. It durably pins the full request, operation ID
and original 24-hour deadline before returning. Replays, including after a crash
before the ensure row exists, must return that original deadline or conflict.

publish advances at most one ordinary admission/verification/recovery step for
source.result, using a stable per-operation/per-full-path publication identity.
It must preserve accepted-work leases, charges, divergence policy and the original
retention event on replay. It never attaches a run root. Different accepted NARs
are conflicts, not replacements. 'accepted' means currently served acceptance,
not a reservation or captured metadata. 'pending' leaves durable normal work.

The parent binds these methods to UploadsService.admitPublication and the
server's publication command/replay/verification coordinator. That coordinator
is private server-owned code; there is deliberately no fake default adapter.
*/
export interface PublicationManifestPublisher {
	readonly admit: (input: PublicationManifestPublication) => Promise<{
		readonly cache: ResolvedCache;
		readonly expiresAt: IsoTimestamp;
		/** Healthy result without a normal publication retention event. Confirm
		it atomically with creation of the ensure receipt, including pin recovery. */
		readonly confirmation?: PublicationManifestAuthoritySnapshot;
	}>;
	readonly publish: (
		input: PublicationManifestPublication & {
			readonly expiresAt: IsoTimestamp;
		}
	) => Promise<
		| { readonly kind: 'pending' }
		| {
				readonly kind: 'accepted';
				readonly result: PublicationResultIdentity;
		  }
	>;
}
