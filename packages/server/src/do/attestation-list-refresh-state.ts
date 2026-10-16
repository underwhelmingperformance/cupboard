import type {
	AttestationListIdentity,
	AttestationListParent,
	AttestationListRevision
} from '../db/attestation-list-revision.ts';
import type { CacheId } from '../db/cache.ts';
import type { R2ObjectKey } from '../http/http.ts';

export interface AttestationListRefreshSource {
	readonly captured: Pick<AttestationListRevision, 'id' | 'revision'>;
	readonly identity: AttestationListIdentity;
	readonly parent: AttestationListParent;
	readonly cacheId?: CacheId;
	readonly precedingKey?: R2ObjectKey;
}

export type AttestationListRefreshFailure =
	| {
			readonly reason: 'source-unavailable';
			readonly digest: import('@cupboard/nix-store/scalars').Sha256HexDigest;
	  }
	| {
			readonly reason: 'staging-invalid';
			readonly detail: import('../errors.ts').AttestationListStagingInvalidError['reason'];
	  };

export const attestationListRefreshCursorKey = 'attestation-list:refresh-after';
