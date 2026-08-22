import type { Logger } from '@cupboard/logger';
import type { StoredCache } from '@cupboard/nix-store/scalars';
import type { VerifyReport } from '@cupboard/protocol/reports';

import type { AccessClaims } from '../auth/auth.ts';
import type { AttestationsService } from '../do/attestations-service.ts';
import type { AuthKeysService } from '../do/auth-keys-service.ts';
import type { CacheAdminService } from '../do/cache-admin-service.ts';
import type { GarbageCollectionOutcome } from '../do/context.ts';
import type { DeletionQueueService } from '../do/deletion-queue-service.ts';
import type { IntegrityCheckService } from '../do/integrity-check-service.ts';
import type { NegotiateHints } from '../do/negotiate-hints.ts';
import type { OidcTrustService } from '../do/oidc-trust-service.ts';
import type { RetentionService } from '../do/retention-service.ts';
import type { ReuseViewAdminService } from '../do/reuse-view-admin-service.ts';
import type { RootsService } from '../do/roots-service.ts';
import type { SigningKeysService } from '../do/signing-keys-service.ts';
import type { StatsService } from '../do/stats-service.ts';
import type { UploadsService } from '../do/uploads-service.ts';
import type { RequestOrigin } from '../http/http.ts';

import type { PendingCacheResolver } from './authorise.ts';

/**
 * The capabilities the contract's procedures need from the Durable Object:
 * authentication, the post-mutation maintenance hook, and the domain services.
 * The object supplies an instance per request through the handler context.
 */
export interface TenantRpcServices {
	authenticate(request: Request): Promise<AccessClaims>;
	pendingCache: PendingCacheResolver;
	// Reconcile maintenance eligibility before a mutation returns. Concurrent
	// calls share one reconciliation, and an unchanged wake time avoids a D1 write.
	afterMutation<T>(body: () => Promise<T>): Promise<T>;
	// Takes the Worker-staged negotiate hints the request's token header
	// references, at most once; absent, unknown or expired tokens read as no
	// hints and negotiate falls back to its own D1 reads.
	takeNegotiateHints(request: Request): NegotiateHints | undefined;
	readonly cacheAdmin: CacheAdminService;
	readonly signingKeys: SigningKeysService;
	readonly authKeys: AuthKeysService;
	readonly retention: RetentionService;
	readonly reuseViews: ReuseViewAdminService;
	readonly oidcTrust: OidcTrustService;
	readonly stats: StatsService;
	readonly integrityCheck: IntegrityCheckService;
	readonly roots: RootsService;
	readonly deletionQueue: DeletionQueueService;
	// Runs an interactive garbage-collection pass, serialised against the cron
	// pass and the alarm resume on this instance, and arms the continuation for
	// any leftover work. The router supplies the cache scope and the caller's purge
	// origin.
	runGarbageCollection(
		logger: Logger,
		cache: StoredCache | undefined,
		purgeOrigin: RequestOrigin | undefined
	): Promise<GarbageCollectionOutcome>;
	readonly uploads: UploadsService;
	readonly attestations: AttestationsService;
	// Runs an interactive verification pass, serialised against the cron verify
	// pass on this instance. The router clamps the limit to the batch ceiling.
	runVerification(
		logger: Logger,
		purgeOrigin: RequestOrigin | undefined,
		limit: number
	): Promise<VerifyReport>;
}

export interface TenantOrpcContext {
	readonly request: Request;
	readonly services: TenantRpcServices;
	readonly logger: Logger;
	readonly resHeaders?: Headers;
}
