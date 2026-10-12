import type { Logger } from '@cupboard/logger';
import type { TenantId } from '@cupboard/nix-store/scalars';
import { eq, sql } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';

import * as schema from '../db/d1-schema.ts';
import {
	boundedSubrequest,
	criticalSectionBudgetMs,
	withDeadlineBudget
} from '../do/deadline.ts';
import {
	hasSubrequestsFor,
	holdSubrequests,
	spendSubrequests,
	type SubrequestHold
} from '../do/subrequest-slice.ts';

import { tenantServer } from './durable-object.ts';

export const attestationListWakeCursorKey = 'attestation-list:wake-after';
const tenantsPerSweep = 8;
const cursorDeadlineReserveMs = 2000;
type WakeTenant = (tenant: TenantId) => Promise<void>;

class AttestationListWakeSweep {
	private after = '';
	private shouldWrite = false;
	private cursorWrite: SubrequestHold | undefined;
	private readonly failures: unknown[] = [];

	constructor(
		private readonly logger: Logger,
		private readonly env: Env,
		private readonly wake: WakeTenant
	) {}

	private async discover(): Promise<void> {
		if (!hasSubrequestsFor(6)) {
			return;
		}
		const database = drizzleD1(this.env.CUPBOARD_DB, { schema });
		const activation = await database
			.select({ state: schema.deploymentTransition.state })
			.from(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'attestation-list-revision'))
			.get();
		if (activation === undefined || activation.state === 'expanded') {
			return;
		}
		this.cursorWrite = holdSubrequests(1);
		spendSubrequests(1, 'kv.attestation-list-wake-read');
		this.after =
			(await boundedSubrequest(
				() => this.env.CRON_STATE.get(attestationListWakeCursorKey),
				'kv.attestation-list-wake-read'
			)) ?? '';
		this.shouldWrite = true;
		for (
			let count = 0;
			count < tenantsPerSweep && hasSubrequestsFor(3);
			count++
		) {
			const candidates = await database.all<{
				tenant: TenantId;
			}>(sql`SELECT tenant
    FROM attestation_list_revision INDEXED BY attestation_list_revision_pending_idx
    WHERE (published_revision IS NULL OR published_revision != revision) AND tenant > ${this.after}
    ORDER BY tenant LIMIT 1`);
			const candidate = candidates.at(0);
			if (candidate === undefined) {
				this.after = '';
				break;
			}
			this.after = candidate.tenant;
			const tenant = await database
				.select({ status: schema.tenant.status })
				.from(schema.tenant)
				.where(eq(schema.tenant.id, candidate.tenant))
				.get();
			if (tenant?.status !== 'active' && tenant?.status !== 'suspended') {
				continue;
			}
			spendSubrequests(1, 'rpc.attestation-list-wake');
			try {
				await boundedSubrequest(
					() => this.wake(candidate.tenant),
					'rpc.attestation-list-wake'
				);
			} catch (error) {
				this.logger.warn('attestation-list refresh wake failed', {
					tenant: candidate.tenant,
					error
				});
				this.failures.push(error);
			}
		}
	}

	private async writeCursor(): Promise<void> {
		this.cursorWrite?.release();
		if (!this.shouldWrite) {
			return;
		}
		spendSubrequests(1, 'kv.attestation-list-wake-write');
		await boundedSubrequest(
			() => this.env.CRON_STATE.put(attestationListWakeCursorKey, this.after),
			'kv.attestation-list-wake-write'
		);
	}

	async run(): Promise<void> {
		try {
			await withDeadlineBudget(
				criticalSectionBudgetMs - cursorDeadlineReserveMs,
				() => this.discover()
			);
		} finally {
			await this.writeCursor();
		}
		if (this.failures.length > 0) {
			throw new AggregateError(
				this.failures,
				'Attestation-list refresh wakes failed'
			);
		}
	}
}

export function wakePendingAttestationLists(
	logger: Logger,
	env: Env,
	wake: WakeTenant = (tenant) =>
		tenantServer(env, tenant).wakeAttestationListRefresh()
): Promise<void> {
	return withDeadlineBudget(criticalSectionBudgetMs, () =>
		new AttestationListWakeSweep(logger, env, wake).run()
	);
}
