import type { AccessClaims } from '../auth/auth.ts';
import type { AttestationsService } from '../do/attestations-service.ts';
import type { AuthKeysService } from '../do/auth-keys-service.ts';
import type { CacheAdminService } from '../do/cache-admin-service.ts';
import type { DeletionQueueService } from '../do/deletion-queue-service.ts';
import type { GarbageCollectionService } from '../do/garbage-collection-service.ts';
import type { IntegrityCheckService } from '../do/integrity-check-service.ts';
import type { OidcTrustService } from '../do/oidc-trust-service.ts';
import type { RetentionService } from '../do/retention-service.ts';
import type { RootsService } from '../do/roots-service.ts';
import type { S3CredentialAdminService } from '../do/s3-credential-admin-service.ts';
import type { SigningKeysService } from '../do/signing-keys-service.ts';
import type { StatsService } from '../do/stats-service.ts';
import type { UploadsService } from '../do/uploads-service.ts';
import type { VerificationService } from '../do/verification-service.ts';

import type { PendingCacheResolver } from './authorise.ts';

/**
 * The capabilities the contract's procedures need from the Durable Object:
 * authentication, the post-mutation maintenance hook, and the domain services.
 * The object supplies an instance per request through the handler context.
 */
export interface TenantRpcServices {
	authenticate(request: Request): Promise<AccessClaims>;
	pendingCache: PendingCacheResolver;
	// Runs a mutating procedure and reconciles the maintenance-eligibility wake time
	// inline, before the request returns. A push runs the procedure once per store
	// path; the reconcile is flat in the in-flight set, and it skips the D1 write when
	// the wake time is unchanged, so a push publishes the wake time once.
	afterMutation<T>(body: () => Promise<T>): Promise<T>;
	readonly cacheAdmin: CacheAdminService;
	readonly signingKeys: SigningKeysService;
	readonly authKeys: AuthKeysService;
	readonly retention: RetentionService;
	readonly oidcTrust: OidcTrustService;
	readonly stats: StatsService;
	readonly integrityCheck: IntegrityCheckService;
	readonly roots: RootsService;
	readonly deletionQueue: DeletionQueueService;
	readonly garbageCollection: GarbageCollectionService;
	readonly uploads: UploadsService;
	readonly attestations: AttestationsService;
	readonly verification: VerificationService;
	readonly s3Credentials: S3CredentialAdminService;
}

/** The initial oRPC context for every tenant procedure call. */
export interface TenantOrpcContext {
	readonly request: Request;
	readonly services: TenantRpcServices;
}
