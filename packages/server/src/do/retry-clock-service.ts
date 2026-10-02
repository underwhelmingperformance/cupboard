import { and, eq, isNull } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { EligibleRetryClock } from '../policy/retry.ts';

import { type ServerContext } from './context.ts';
import { hasSubrequestsFor } from './subrequest-slice.ts';

export class RetryClockService {
	constructor(private readonly context: ServerContext) {}

	isBlocked(): boolean {
		return (
			this.context.db
				.select()
				.from(schema.retryEligibility)
				.where(eq(schema.retryEligibility.id, 'tenant'))
				.get()?.isEligible === false
		);
	}

	async read(): Promise<EligibleRetryClock | undefined> {
		if (!hasSubrequestsFor(1)) {
			return undefined;
		}

		const clock = this.context.d1
			.select({
				status: d1Schema.tenant.status,
				activeElapsedMs: d1Schema.tenant.retryActiveElapsedMs,
				activeSinceMs: d1Schema.tenant.retryActiveSinceMs
			})
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, this.context.requireTenant()));
		let tenant = await clock.get();
		if (tenant?.status === 'active' && tenant.activeSinceMs === null) {
			if (!hasSubrequestsFor(2)) {
				return undefined;
			}
			const initialisationFilter = and(
				eq(d1Schema.tenant.id, this.context.requireTenant()),
				eq(d1Schema.tenant.status, 'active'),
				isNull(d1Schema.tenant.retryActiveSinceMs)
			);
			const [initialised] = await this.context.d1
				.update(d1Schema.tenant)
				.set({ retryActiveSinceMs: Date.now() })
				.where(initialisationFilter)
				.returning({
					status: d1Schema.tenant.status,
					activeElapsedMs: d1Schema.tenant.retryActiveElapsedMs,
					activeSinceMs: d1Schema.tenant.retryActiveSinceMs
				});
			tenant = initialised ?? (await clock.get());
		}

		const isEligible = tenant?.status === 'active';
		this.context.db
			.insert(schema.retryEligibility)
			.values({ id: 'tenant', isEligible })
			.onConflictDoUpdate({
				target: schema.retryEligibility.id,
				set: { isEligible }
			})
			.run();

		return tenant === undefined
			? undefined
			: new EligibleRetryClock({
					...tenant,
					activeSinceMs: tenant.activeSinceMs ?? undefined
				});
	}
}
