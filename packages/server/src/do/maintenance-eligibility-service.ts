import { type CacheScope } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	asc,
	eq,
	isNotNull,
	isNull,
	lte,
	or,
	type SQL,
	sql
} from 'drizzle-orm';

import { type CacheId } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';

import { type ServerContext } from './context.ts';
import {
	subrequestSliceReserve,
	withHeldSubrequests
} from './subrequest-slice.ts';

// Use one fixed past instant for work due now. Repeated mutations in the same
// push then leave the published wake time unchanged.
const wakeImmediately = isoTimestamp(new Date(0));
const managedRetirementRetryMs = 6 * 60 * 60 * 1000;

export class MaintenanceEligibilityService {
	constructor(private readonly context: ServerContext) {}

	// Indexed existence checks keep this calculation independent of the number
	// of pending uploads and queued deletions.
	private hasImmediateWork(): boolean {
		const awaitingVerification = this.context.db
			.select({ present: sql`1` })
			.from(schema.pendingUploads)
			.where(
				or(
					eq(schema.pendingUploads.verdict, 'pending'),
					eq(schema.pendingUploads.verdict, 'committing')
				)
			)
			.limit(1)
			.get();

		if (awaitingVerification !== undefined) {
			return true;
		}

		const queuedDeletion = this.context.db
			.select({ present: sql`1` })
			.from(schema.narInfoDeletions)
			.limit(1)
			.get();

		return queuedDeletion !== undefined;
	}

	private earliestUploadExpiry(): IsoTimestamp | undefined {
		const pendingUploadExpiry = this.context.db
			.select({ expiresAt: schema.pendingUploads.expiresAt })
			.from(schema.pendingUploads)
			.orderBy(asc(schema.pendingUploads.expiresAt))
			.limit(1)
			.get()?.expiresAt;
		const pendingAttestationExpiry = this.context.db
			.select({ expiresAt: schema.pendingAttestations.expiresAt })
			.from(schema.pendingAttestations)
			.orderBy(asc(schema.pendingAttestations.expiresAt))
			.limit(1)
			.get()?.expiresAt;

		return [pendingUploadExpiry, pendingAttestationExpiry]
			.filter((value) => value !== undefined)
			.toSorted(byCodeUnit)[0];
	}

	private earliestRootExpiry(): IsoTimestamp | undefined {
		return (
			this.context.db
				.select({ expiresAt: schema.retentionRoots.expiresAt })
				.from(schema.retentionRoots)
				.where(isNotNull(schema.retentionRoots.expiresAt))
				.orderBy(asc(schema.retentionRoots.expiresAt))
				.limit(1)
				.get()?.expiresAt ?? undefined
		);
	}

	private earliestGraceExpiry(): IsoTimestamp | undefined {
		return (
			this.context.db
				.select({ retainUntil: schema.retentionGrace.retainUntil })
				.from(schema.retentionGrace)
				.orderBy(asc(schema.retentionGrace.retainUntil))
				.limit(1)
				.get()?.retainUntil ?? undefined
		);
	}

	private earliestAuthKeyRetirement(): IsoTimestamp | undefined {
		return (
			this.context.db
				.select({ scheduledRetireAt: schema.authKeys.scheduledRetireAt })
				.from(schema.authKeys)
				.where(
					and(
						isNull(schema.authKeys.retiredAt),
						isNotNull(schema.authKeys.scheduledRetireAt)
					)
				)
				.orderBy(asc(schema.authKeys.scheduledRetireAt))
				.limit(1)
				.get()?.scheduledRetireAt ?? undefined
		);
	}

	private earliestManagedCacheRetirement(): IsoTimestamp | undefined {
		return this.context.db
			.select({ nextCheckAt: schema.managedCacheRetirements.nextCheckAt })
			.from(schema.managedCacheRetirements)
			.orderBy(asc(schema.managedCacheRetirements.nextCheckAt))
			.limit(1)
			.get()?.nextCheckAt;
	}

	// Choose the earliest upload, attestation, root, grace, auth-key, or
	// managed-cache retirement deadline when no immediate work is recorded.
	private earliestFutureWake(): IsoTimestamp | undefined {
		return [
			this.earliestUploadExpiry(),
			this.earliestRootExpiry(),
			this.earliestGraceExpiry(),
			this.earliestAuthKeyRetirement(),
			this.earliestManagedCacheRetirement()
		]
			.filter((value) => value !== undefined)
			.toSorted(byCodeUnit)[0];
	}

	private nextWakeAt(): IsoTimestamp | undefined {
		return this.hasImmediateWork()
			? wakeImmediately
			: this.earliestFutureWake();
	}

	retirementRevision(
		cacheId: CacheId
	): { readonly incarnation: string; readonly revision: number } | undefined {
		const now = isoTimestamp(new Date());

		return this.context.db
			.select({
				incarnation: schema.managedCacheRetirements.incarnation,
				revision: schema.managedCacheRetirements.revision
			})
			.from(schema.managedCacheRetirements)
			.where(
				and(
					eq(schema.managedCacheRetirements.cacheId, cacheId),
					lte(schema.managedCacheRetirements.eligibleAfter, now)
				)
			)
			.get();
	}

	invalidateRetirementRecheck(scope?: CacheScope | CacheId): void {
		const cacheId =
			typeof scope === 'number'
				? scope
				: scope === undefined
					? undefined
					: this.context.cacheRepository.resolve(scope)?.id;

		if (scope !== undefined && cacheId === undefined) {
			return;
		}

		this.context.db
			.update(schema.managedCacheRetirements)
			.set({
				revision: sql`${schema.managedCacheRetirements.revision} + 1`,
				nextCheckAt: sql`${schema.managedCacheRetirements.eligibleAfter}`
			})
			.where(
				cacheId === undefined
					? undefined
					: eq(schema.managedCacheRetirements.cacheId, cacheId)
			)
			.run();
	}

	completeRetirementRecheck(
		cacheId: CacheId,
		observed: { readonly incarnation: string; readonly revision: number },
		now = new Date()
	): void {
		const retryAt = isoTimestamp(
			new Date(now.getTime() + managedRetirementRetryMs)
		);
		const checkedAt = isoTimestamp(now);

		this.context.db
			.update(schema.managedCacheRetirements)
			.set({ nextCheckAt: retryAt })
			.where(
				and(
					eq(schema.managedCacheRetirements.cacheId, cacheId),
					eq(schema.managedCacheRetirements.incarnation, observed.incarnation),
					eq(schema.managedCacheRetirements.revision, observed.revision),
					lte(schema.managedCacheRetirements.eligibleAfter, checkedAt),
					lte(schema.managedCacheRetirements.nextCheckAt, checkedAt)
				)
			)
			.run();
	}

	async invalidate(): Promise<void> {
		await this.context.d1
			.delete(d1Schema.tenantMaintenanceEligibility)
			.where(
				eq(
					d1Schema.tenantMaintenanceEligibility.tenant,
					this.context.requireTenant()
				)
			)
			.run();
	}

	// Publish with a conditional upsert so stale reconciliation cannot overwrite
	// a newer wake time. Repeated mutations that calculate the same time do not
	// rewrite D1.
	async reconcile(now: Date = new Date()): Promise<void> {
		const tenant = this.context.requireTenant();
		const reconciledAt = isoTimestamp(now);
		const nextWakeAt = this.nextWakeAt();

		await this.context.d1
			.insert(d1Schema.tenantMaintenanceEligibility)
			.values({ tenant, nextWakeAt, reconciledAt })
			.onConflictDoUpdate({
				target: d1Schema.tenantMaintenanceEligibility.tenant,
				set: {
					nextWakeAt: nextWakeAt ?? sql`null`,
					reconciledAt
				},
				setWhere: maintenanceWakeWins(nextWakeAt, reconciledAt)
			})
			.run();
	}
}

// Prefer an earlier wake even when reconciliation timestamps tie. Waking too
// early costs one scheduler pass; accepting a later stale value can strand
// work. Otherwise, only a strictly newer reconciliation may change the wake.
function maintenanceWakeWins(
	nextWakeAt: IsoTimestamp | undefined,
	reconciledAt: IsoTimestamp
): SQL {
	const { nextWakeAt: storedWake, reconciledAt: storedReconciledAt } =
		d1Schema.tenantMaintenanceEligibility;
	const incomingWake = nextWakeAt ?? sql`null`;

	const fresherAndChanged = sql`${storedWake} is not ${incomingWake} and ${reconciledAt} > ${storedReconciledAt}`;
	const sooner = sql`${incomingWake} is not null and (${storedWake} is null or ${incomingWake} < ${storedWake})`;

	return sql`(${fresherAndChanged}) or (${sooner})`;
}

// Reconciliation can make one D1 call before an error. The fallback
// invalidation requires another, so the body reserves two calls. The
// leading invalidation runs before the body starts.
const trailingEligibilitySubrequests = 2;
const leadingEligibilitySubrequests = 1;

/**
 * The tracked binding calls a maintenance pass has for its own work.
 *
 * A pass spends one D1 call invalidating the eligibility projection before
 * its body and keeps two calls for reconciliation after it.
 *
 * Pages use the remaining allowance and call-cost constants to choose an
 * initial size. Callers retain unprocessed work for a later invocation.
 */
export function maintenancePassSubrequests(
	subrequestAllowance: number
): number {
	return (
		subrequestAllowance -
		subrequestSliceReserve -
		leadingEligibilitySubrequests -
		trailingEligibilitySubrequests
	);
}

/**
 * Invalidates the tenant's eligibility projection, runs `body`, and reconciles
 * the projection afterwards.
 *
 * Reconciliation also runs after an error from `body`. The function reserves
 * its D1 calls from the invocation's subrequest slice before calling `body`.
 */
export async function withMaintenanceEligibility<T>(
	maintenanceEligibility: MaintenanceEligibilityService,
	reconcileMaintenanceEligibility: () => Promise<void>,
	body: () => Promise<T>
): Promise<T> {
	await maintenanceEligibility.invalidate();

	try {
		return await withHeldSubrequests(trailingEligibilitySubrequests, body);
	} finally {
		await reconcileMaintenanceEligibility();
	}
}
