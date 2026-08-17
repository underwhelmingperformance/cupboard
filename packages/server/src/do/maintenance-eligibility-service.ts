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

import { type ServerContext } from './context.ts';

// A tenant with work due now should be woken on the scheduler's next pass. We store a
// fixed past instant, so the many mutations of a single push leave the wake time
// unchanged and skip the redundant D1 write.
const wakeImmediately = isoTimestamp(new Date(0));

export class MaintenanceEligibilityService {
	constructor(private readonly context: ServerContext) {}

	// Whether the tenant has work due now: an upload awaiting verification, or a
	// queued narinfo deletion. Both are existence checks served by an index, so
	// each costs a single indexed row lookup whatever the size of the in-flight
	// set. The wake time can therefore be recomputed on every mutation in a
	// large push without the read load becoming quadratic.
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

	private async earliestS3Expiry(): Promise<IsoTimestamp | undefined> {
		const tenant = this.context.requireTenant();
		const [multipart, staged] = await this.context.d1.batch([
			this.context.d1
				.select({ expiresAt: d1Schema.s3MultipartUpload.expiresAt })
				.from(d1Schema.s3MultipartUpload)
				.where(eq(d1Schema.s3MultipartUpload.tenant, tenant))
				.orderBy(asc(d1Schema.s3MultipartUpload.expiresAt))
				.limit(1),
			this.context.d1
				.select({ expiresAt: d1Schema.s3StagedObject.expiresAt })
				.from(d1Schema.s3StagedObject)
				.where(eq(d1Schema.s3StagedObject.tenant, tenant))
				.orderBy(asc(d1Schema.s3StagedObject.expiresAt))
				.limit(1)
		]);

		return [multipart[0]?.expiresAt, staged[0]?.expiresAt]
			.filter((value) => value !== undefined)
			.toSorted(byCodeUnit)[0];
	}

	// The soonest deferred deadline once there is nothing due now: an upload or
	// attestation expiry, a retention-root TTL, a retention-grace deadline, or an
	// auth-key retirement.
	private async earliestFutureWake(): Promise<IsoTimestamp | undefined> {
		return [
			this.earliestUploadExpiry(),
			this.earliestRootExpiry(),
			this.earliestGraceExpiry(),
			this.earliestAuthKeyRetirement(),
			await this.earliestS3Expiry()
		]
			.filter((value) => value !== undefined)
			.toSorted(byCodeUnit)[0];
	}

	private async nextWakeAt(): Promise<IsoTimestamp | undefined> {
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

	// Recomputes the tenant's wake time and publishes it to D1 where the scheduler
	// reads it. A single conditional upsert settles the publish atomically: the row is
	// rewritten only when the wake time actually moves, and a stale reconcile racing a
	// fresher one cannot overwrite it (see `maintenanceWakeWins`). So a push whose
	// mutations all leave the same wake time costs one effective D1 write, not one per
	// path, and concurrent same-tenant reconciles need no external lock.
	async reconcile(now: Date = new Date()): Promise<void> {
		const tenant = this.context.requireTenant();
		const reconciledAt = isoTimestamp(now);
		const nextWakeAt = await this.nextWakeAt();

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

// The conflict rule that keeps the published wake time atomic without a lock. On a
// conflict the row is rewritten only when the new wake time differs from the stored
// one and this reconcile is strictly newer than the stored one, so neither a stale
// reconcile nor a same-instant one can clobber a fresher publish. The second clause
// lets any real incoming wake that is sooner than the stored one win whatever the
// timestamps, where a stored NULL (an idle tenant, no wake) counts as the latest
// possible time so a tenant that just became due always wins, even on a timestamp tie:
// publishing too early only costs a wasted scheduler tick, whereas publishing too late
// would strand due work, so ties resolve towards waking. The comparisons run against
// the values this upsert binds, so no `excluded` reference is needed.
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

export async function withMaintenanceEligibility<T>(
	maintenanceEligibility: MaintenanceEligibilityService,
	reconcileMaintenanceEligibility: () => Promise<void>,
	body: () => Promise<T>
): Promise<T> {
	await maintenanceEligibility.invalidate();

	try {
		return await body();
	} finally {
		await reconcileMaintenanceEligibility();
	}
}
