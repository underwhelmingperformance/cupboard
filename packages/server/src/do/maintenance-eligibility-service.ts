import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	asc,
	eq,
	isNotNull,
	isNull,
	or,
	type SQL,
	sql
} from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { d1StatementsPerInvocation } from '../http/http.ts';

import { type ServerContext } from './context.ts';
import { withHeldStatements } from './statement-scope.ts';

// Use one fixed past instant for work due now. Repeated mutations in the same
// push then leave the published wake time unchanged.
const wakeImmediately = isoTimestamp(new Date(0));

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

	// When no work is due now, wake for the earliest upload, attestation, root,
	// grace, or auth-key deadline.
	private earliestFutureWake(): IsoTimestamp | undefined {
		return [
			this.earliestUploadExpiry(),
			this.earliestRootExpiry(),
			this.earliestGraceExpiry(),
			this.earliestAuthKeyRetirement()
		]
			.filter((value) => value !== undefined)
			.toSorted(byCodeUnit)[0];
	}

	private nextWakeAt(): IsoTimestamp | undefined {
		return this.hasImmediateWork()
			? wakeImmediately
			: this.earliestFutureWake();
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

// Reconciliation can spend one D1 statement before an error. The fallback
// invalidation requires another, so the body reserves two statements. The
// leading invalidation runs before the body starts.
const trailingEligibilityStatements = 2;
const leadingEligibilityStatements = 1;

/**
 * The D1 statements a maintenance pass has for its own work.
 *
 * A pass spends one statement invalidating the eligibility projection before
 * its body and keeps two back for the reconciliation after it.
 *
 * Pages use the remaining allowance and the cost constants to choose an initial
 * size. Those constants are page hints only. If an estimate drifts, the binding
 * refuses the next D1 call before it is sent, and the caller retains the
 * unprocessed work for a later invocation.
 */
export const maintenancePassStatements =
	d1StatementsPerInvocation -
	leadingEligibilityStatements -
	trailingEligibilityStatements;

/**
 * Invalidates the tenant's eligibility projection, runs `body`, and reconciles
 * the projection afterwards.
 *
 * Reconciliation also runs after an error from `body`. The function reserves
 * its statements from the invocation's D1 allowance before calling `body`.
 */
export async function withMaintenanceEligibility<T>(
	maintenanceEligibility: MaintenanceEligibilityService,
	reconcileMaintenanceEligibility: () => Promise<void>,
	body: () => Promise<T>
): Promise<T> {
	await maintenanceEligibility.invalidate();

	try {
		return await withHeldStatements(trailingEligibilityStatements, body);
	} finally {
		await reconcileMaintenanceEligibility();
	}
}
