import { type CacheScope } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	asc,
	eq,
	gt,
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
import { UploadRetrySchedule } from './upload-retry-schedule.ts';

// Use one fixed past instant for work due now. Repeated mutations in the same
// push then leave the published wake time unchanged.
const wakeImmediately = isoTimestamp(new Date(0));

// A fresh maintenance pass writes this wake while it runs. It is due, it
// differs from `wakeImmediately`, and no reconciliation computes an earlier
// wake, so a sooner wake never replaces it.
const passInProgress = isoTimestamp(new Date(-1));

const managedRetirementRetryMs = 6 * 60 * 60 * 1000;

export class MaintenanceEligibilityService {
	// The object has one instance of this service, so the count covers every
	// fresh pass that the object is running.
	private freshPasses = 0;
	private passMark: Promise<void> = Promise.resolve();
	private passPublication: Promise<void> = Promise.resolve();
	private readonly publications = new Set<Promise<unknown>>();

	constructor(private readonly context: ServerContext) {}

	private earliestInheritanceWake(): IsoTimestamp | undefined {
		const queued = this.context.db
			.select({ at: schema.attestationInheritances.notBefore })
			.from(schema.attestationInheritances)
			.orderBy(schema.attestationInheritances.notBefore)
			.limit(1)
			.get()?.at;
		const expires = this.context.db
			.select({ at: schema.attestationInheritanceFailures.expiresAt })
			.from(schema.attestationInheritanceFailures)
			.orderBy(schema.attestationInheritanceFailures.expiresAt)
			.limit(1)
			.get()?.at;
		return [queued, expires]
			.filter((at) => at !== undefined)
			.toSorted(byCodeUnit)[0];
	}

	// Indexed existence checks keep this calculation independent of the number
	// of pending uploads and queued deletions.
	private hasImmediateWork(now: IsoTimestamp): boolean {
		const retryAt = new UploadRetrySchedule(this.context).projectedAt();
		if (retryAt !== undefined && retryAt <= Date.parse(now)) {
			return true;
		}

		const inheritanceAt = this.earliestInheritanceWake();
		if (inheritanceAt !== undefined && inheritanceAt <= now) {
			return true;
		}

		const queuedDeletion = this.context.db
			.select({ present: sql`1` })
			.from(schema.narInfoDeletions)
			.limit(1)
			.get();

		if (queuedDeletion !== undefined) {
			return true;
		}
		const teardown = this.context.db
			.select({ present: sql`1` })
			.from(schema.cacheTeardowns)
			.limit(1)
			.get();
		if (teardown !== undefined) {
			return true;
		}
		return [
			schema.legacyRefreshTokenMembers,
			schema.legacyRefreshTokenFamilies,
			schema.legacyRefreshTokens
		].some(
			(table) =>
				this.context.db
					.select({ present: sql`1` })
					.from(table)
					.limit(1)
					.get() !== undefined
		);
	}

	private earliestUploadExpiry(): IsoTimestamp | undefined {
		const pendingUploadExpiry = this.context.db.all<{
			expiresAt: IsoTimestamp;
		}>(sql`SELECT expires_at AS expiresAt
			FROM pending_upload INDEXED BY pending_upload_terminal_expires_at_idx
			WHERE verdict IS NULL OR verdict = 'servable' OR verdict = 'mismatch' OR verdict = 'over-quota'
			ORDER BY expires_at, id
			LIMIT 1`)[0]?.expiresAt;
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
	private earliestFutureWake(now: IsoTimestamp): IsoTimestamp | undefined {
		return [
			this.earliestSettleRetry(now),
			this.earliestInheritanceWake(),
			this.earliestUploadExpiry(),
			this.earliestRootExpiry(),
			this.earliestGraceExpiry(),
			this.earliestAuthKeyRetirement(),
			this.earliestManagedCacheRetirement(),
			this.earliestRefreshMaintenance(),
			this.earliestSubjectNonceExpiry()
		]
			.filter((value) => value !== undefined)
			.toSorted(byCodeUnit)[0];
	}

	private earliestRefreshMaintenance(): IsoTimestamp | undefined {
		const family = this.context.db
			.select({ expiresAt: schema.refreshTokenFamilies.expiresAt })
			.from(schema.refreshTokenFamilies)
			.orderBy(
				asc(schema.refreshTokenFamilies.expiresAt),
				asc(schema.refreshTokenFamilies.id)
			)
			.limit(1)
			.get()?.expiresAt;
		const envelope =
			this.context.db
				.select({ expiresAt: schema.refreshTokenMembers.successorExpiresAt })
				.from(schema.refreshTokenMembers)
				.where(isNotNull(schema.refreshTokenMembers.successorExpiresAt))
				.orderBy(
					asc(schema.refreshTokenMembers.successorExpiresAt),
					asc(schema.refreshTokenMembers.id)
				)
				.limit(1)
				.get()?.expiresAt ?? undefined;
		return [family, envelope]
			.filter((value) => value !== undefined)
			.toSorted(byCodeUnit)[0];
	}

	private earliestSubjectNonceExpiry(): IsoTimestamp | undefined {
		return this.context.db
			.select({ expiresAt: schema.consumedSubjectNonces.expiresAt })
			.from(schema.consumedSubjectNonces)
			.orderBy(asc(schema.consumedSubjectNonces.expiresAt))
			.limit(1)
			.get()?.expiresAt;
	}

	private earliestSettleRetry(now: IsoTimestamp): IsoTimestamp | undefined {
		const retryAt = new UploadRetrySchedule(this.context).projectedAt();
		return retryAt !== undefined && retryAt > Date.parse(now)
			? isoTimestamp(new Date(retryAt))
			: undefined;
	}

	private nextWakeAt(now: IsoTimestamp): IsoTimestamp | undefined {
		return this.hasImmediateWork(now)
			? wakeImmediately
			: this.earliestFutureWake(now);
	}

	// D1 may apply concurrent writes in any order. A reconciliation that is
	// still in flight could otherwise land after the mark and replace it.
	private async markPassInProgress(): Promise<void> {
		await Promise.allSettled(this.publications);

		const { tenant, nextWakeAt } = d1Schema.tenantMaintenanceEligibility;
		const now = isoTimestamp(new Date());
		const notDue = or(isNull(nextWakeAt), gt(nextWakeAt, now));
		const ownRow = eq(tenant, this.context.requireTenant());

		await this.context.d1
			.update(d1Schema.tenantMaintenanceEligibility)
			.set({ nextWakeAt: passInProgress })
			.where(and(ownRow, notDue))
			.run();
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

	/**
	 * Starts a fresh pass. The first of several concurrent fresh passes marks
	 * the row with {@link passInProgress} unless the row is already due or
	 * absent, and every pass waits for that mark. The mark waits for any
	 * reconciliation in flight. If the mark fails, the pass does not start.
	 */
	async beginFreshPass(): Promise<void> {
		this.freshPasses += 1;

		if (this.freshPasses === 1) {
			this.passMark = this.markPassInProgress();
		}

		try {
			await this.passMark;
		} catch (error) {
			this.freshPasses -= 1;

			throw error;
		}
	}

	/**
	 * Ends a fresh pass and returns whether it was the last one running. The
	 * caller reconciles with `pass` only when it was the last.
	 */
	endFreshPass(): boolean {
		this.freshPasses -= 1;

		return this.freshPasses === 0;
	}

	/**
	 * Publishes the tenant's next wake with a conditional upsert, so a stale
	 * reconciliation cannot replace a newer wake and an unchanged wake writes
	 * nothing.
	 *
	 * While a fresh pass runs, only that pass's final reconciliation publishes.
	 * Every other reconciliation returns without writing, because the row stays
	 * due until the pass ends and the pass then reads the final state.
	 */
	async reconcile(
		now: Date = new Date(),
		change: WakeChange = 'any'
	): Promise<void> {
		if (change !== 'pass') {
			if (this.freshPasses > 0) {
				return;
			}

			// D1 can apply concurrent writes in either order, and a pass's final
			// publication replaces the in-progress wake whatever its timestamp. A
			// reconciliation that starts while that publication is in flight
			// therefore waits for it, so the older pass state cannot land last.
			await this.passPublication;

			if (this.freshPasses > 0) {
				return;
			}
		}

		const tenant = this.context.requireTenant();
		const reconciledAt = isoTimestamp(now);
		const nextWakeAt = this.nextWakeAt(reconciledAt);

		const publication = this.context.d1
			.insert(d1Schema.tenantMaintenanceEligibility)
			.values({ tenant, nextWakeAt, reconciledAt })
			.onConflictDoUpdate({
				target: d1Schema.tenantMaintenanceEligibility.tenant,
				set: {
					nextWakeAt: nextWakeAt ?? sql`null`,
					reconciledAt
				},
				setWhere: maintenanceWakeWins(nextWakeAt, reconciledAt, change)
			})
			.run();
		this.publications.add(publication);

		if (change === 'pass') {
			this.passPublication = completion(publication);
		}

		try {
			await publication;
		} finally {
			this.publications.delete(publication);
		}
	}
}

async function completion(publication: Promise<unknown>): Promise<void> {
	try {
		await publication;
	} catch {
		// The reconciliation that sent the publication handles its failure.
	}
}

/**
 * How a reconciliation may change the stored wake.
 *
 * - `pass`: the final reconciliation of a fresh pass. It may replace any
 *   stored wake, including {@link passInProgress}.
 * - `any`: a reconciliation outside a pass, such as after an admin mutation,
 *   a token exchange or a configuration change. It may move the wake earlier
 *   or later, but leaves {@link passInProgress} in place, so a pass that
 *   stopped early keeps the tenant due until the next fresh pass ends.
 * - `sooner`: a reconciliation after a commit or a continuation. It only
 *   moves the wake earlier, and also leaves {@link passInProgress} in place.
 *   A later wake waits for the next fresh pass.
 */
export type WakeChange = 'pass' | 'any' | 'sooner';

// Prefer an earlier wake even when reconciliation timestamps tie. Waking too
// early costs one scheduler pass; accepting a later stale value can strand
// work. Otherwise, only a strictly newer reconciliation may change the wake.
//
// The final reconciliation of a fresh pass also wins a tie. The object skips
// every other reconciliation while the pass runs, so this one reads the
// latest state.
function maintenanceWakeWins(
	nextWakeAt: IsoTimestamp | undefined,
	reconciledAt: IsoTimestamp,
	change: WakeChange
): SQL {
	const { nextWakeAt: storedWake, reconciledAt: storedReconciledAt } =
		d1Schema.tenantMaintenanceEligibility;
	const incomingWake = nextWakeAt ?? sql`null`;
	const sooner = sql`${incomingWake} is not null and (${storedWake} is null or ${incomingWake} < ${storedWake})`;

	if (change === 'pass') {
		const changed = sql`${storedWake} is not ${incomingWake} and ${reconciledAt} >= ${storedReconciledAt}`;

		return sql`${storedWake} = ${passInProgress} or (${changed}) or (${sooner})`;
	}

	if (change === 'sooner') {
		return sql`${storedWake} is not ${passInProgress} and (${sooner})`;
	}

	const fresherAndChanged = sql`${storedWake} is not ${incomingWake} and ${reconciledAt} > ${storedReconciledAt}`;

	return sql`${storedWake} is not ${passInProgress} and ((${fresherAndChanged}) or (${sooner}))`;
}

// Reconciliation can make one D1 call before an error. The fallback
// invalidation requires another, so the body reserves two calls. A fresh
// pass writes its mark before the body starts.
const trailingEligibilitySubrequests = 2;
const leadingEligibilitySubrequests = 1;

/**
 * The tracked binding calls that a maintenance pass has for its own work.
 *
 * A fresh pass spends one D1 call marking the eligibility row before its body,
 * and every pass keeps two calls for reconciliation after it.
 *
 * Pages use the remaining allowance and call-cost constants to choose an
 * initial size. Callers retain unprocessed work for a later invocation.
 */
export function maintenancePassSubrequests(
	subrequestAllowance: number,
	trigger: PassTrigger
): number {
	const leading = trigger === 'fresh' ? leadingEligibilitySubrequests : 0;

	return (
		subrequestAllowance -
		subrequestSliceReserve -
		leading -
		trailingEligibilitySubrequests
	);
}

/**
 * What started a maintenance pass.
 *
 * - `fresh`: a cron maintenance pass or an admin cache teardown. The cron
 *   reruns a pass that stopped early only while the tenant is due, so the
 *   pass marks the eligibility row first. Its final reconciliation may move
 *   the wake later.
 * - `continuation`: the object's alarm or the verification queue. Cloudflare
 *   retries an alarm handler that fails. The queue retries its message, and
 *   the verify backstop alarm requests another pass when a claim's lease
 *   ends. The durable state that made the pass due therefore keeps it due,
 *   so the pass does not mark the row, and its reconciliation only moves the
 *   wake earlier.
 */
export type PassTrigger = 'fresh' | 'continuation';

/**
 * Runs `body` as a maintenance pass and reconciles the tenant's eligibility
 * row afterwards, including after an error from `body`.
 *
 * A fresh pass first marks the row so that the tenant stays due if the pass
 * stops before it reconciles. When several fresh passes run at once, only
 * the last one to end reconciles. Before calling `body`, the function
 * reserves the reconciliation's D1 calls from the invocation's subrequest
 * slice.
 */
export async function withMaintenanceEligibility<T>(
	maintenanceEligibility: MaintenanceEligibilityService,
	reconcileMaintenanceEligibility: (change: WakeChange) => Promise<void>,
	trigger: PassTrigger,
	body: () => Promise<T>
): Promise<T> {
	if (trigger === 'continuation') {
		try {
			return await withHeldSubrequests(trailingEligibilitySubrequests, body);
		} finally {
			await reconcileMaintenanceEligibility('sooner');
		}
	}

	await maintenanceEligibility.beginFreshPass();

	try {
		return await withHeldSubrequests(trailingEligibilitySubrequests, body);
	} finally {
		if (maintenanceEligibility.endFreshPass()) {
			await reconcileMaintenanceEligibility('pass');
		}
	}
}
