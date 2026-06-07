import { and, asc, count, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';

import { type ServerContext } from './context.ts';

export interface MaintenanceEligibilitySnapshot {
	readonly tenant: string;
	readonly pendingVerificationCount: number;
	readonly earliestUploadExpiry: string | undefined;
	readonly queuedNarInfoDeletionCount: number;
	readonly earliestRootExpiry: string | undefined;
	readonly nextMaintenanceAt: string | undefined;
	readonly reconciledAt: string;
}

export class MaintenanceEligibilityService {
	constructor(private readonly context: ServerContext) {}

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

	reconcile(now: Date = new Date()): Promise<MaintenanceEligibilitySnapshot> {
		const tenant = this.context.requireTenant();
		const reconciledAt = now.toISOString();
		const pendingVerificationCount = this.pendingVerificationCount();
		const earliestUploadExpiry = this.earliestUploadExpiry();
		const queuedNarInfoDeletionCount = this.queuedNarInfoDeletionCount();
		const earliestRootExpiry = this.earliestRootExpiry();
		const earliestAuthKeyRetirement = this.earliestAuthKeyRetirement();
		const nextMaintenanceAt = this.nextMaintenanceAt({
			now: reconciledAt,
			pendingVerificationCount,
			earliestUploadExpiry,
			queuedNarInfoDeletionCount,
			earliestRootExpiry,
			earliestAuthKeyRetirement
		});
		const snapshot = {
			tenant,
			pendingVerificationCount,
			earliestUploadExpiry,
			queuedNarInfoDeletionCount,
			earliestRootExpiry,
			nextMaintenanceAt,
			reconciledAt
		} satisfies MaintenanceEligibilitySnapshot;

		return this.context.d1
			.insert(d1Schema.tenantMaintenanceEligibility)
			.values(snapshot)
			.onConflictDoUpdate({
				target: d1Schema.tenantMaintenanceEligibility.tenant,
				set: {
					pendingVerificationCount,
					earliestUploadExpiry: earliestUploadExpiry ?? sql`null`,
					queuedNarInfoDeletionCount,
					earliestRootExpiry: earliestRootExpiry ?? sql`null`,
					nextMaintenanceAt: nextMaintenanceAt ?? sql`null`,
					reconciledAt
				}
			})
			.run()
			.then(() => snapshot);
	}

	private pendingVerificationCount(): number {
		const row = this.context.db
			.select({ count: count() })
			.from(schema.pendingUploads)
			.where(
				or(
					eq(schema.pendingUploads.verdict, 'pending'),
					eq(schema.pendingUploads.verdict, 'committing')
				)
			)
			.get();

		return row?.count ?? 0;
	}

	private earliestUploadExpiry(): string | undefined {
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
			.toSorted()[0];
	}

	private queuedNarInfoDeletionCount(): number {
		const row = this.context.db
			.select({ count: count() })
			.from(schema.narInfoDeletions)
			.get();

		return row?.count ?? 0;
	}

	private earliestRootExpiry(): string | undefined {
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

	private earliestAuthKeyRetirement(): string | undefined {
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

	private nextMaintenanceAt(input: {
		readonly now: string;
		readonly pendingVerificationCount: number;
		readonly earliestUploadExpiry: string | undefined;
		readonly queuedNarInfoDeletionCount: number;
		readonly earliestRootExpiry: string | undefined;
		readonly earliestAuthKeyRetirement: string | undefined;
	}): string | undefined {
		if (
			input.pendingVerificationCount > 0 ||
			input.queuedNarInfoDeletionCount > 0
		) {
			return input.now;
		}

		return [
			input.earliestUploadExpiry,
			input.earliestRootExpiry,
			input.earliestAuthKeyRetirement
		]
			.filter((value) => value !== undefined)
			.toSorted()[0];
	}
}
