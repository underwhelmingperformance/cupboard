import { type TenantId } from '@cupboard/nix-store/scalars';
import { localStepErrorMaxLength } from '@cupboard/protocol/deployment';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { eq, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from './d1-schema.ts';

/**
 * The outcome of one attempt at a tenant's local-step work, as its tenant row
 * records it. Only a `failed` attempt records an error.
 *
 * A `finished` attempt is a page that recorded the step that the object was
 * asked for. It clears the attempt time as well, because the object has no
 * work left. When a later required
 * step leaves the tenant pending again, the row therefore reads as unwoken
 * until a wake reaches the object. `progressed` is whether the page projected
 * or moved an item.
 */
export type LocalStepAttempt =
	| { readonly kind: 'progressed'; readonly at: IsoTimestamp }
	| { readonly kind: 'unchanged'; readonly at: IsoTimestamp }
	| {
			readonly kind: 'failed';
			readonly at: IsoTimestamp;
			readonly error: string;
	  }
	| {
			readonly kind: 'finished';
			readonly at: IsoTimestamp;
			readonly progressed: boolean;
	  };

/**
 * Writes an attempt to the tenant's row. Every write replaces the previous
 * attempt's time and error. An attempt that did not progress leaves the time
 * of the last progress unchanged.
 */
export function recordLocalStepAttempt(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	attempt: LocalStepAttempt
) {
	return database
		.update(d1Schema.tenant)
		.set({
			localStepAttemptedAt:
				attempt.kind === 'finished' ? sql`null` : attempt.at,
			localStepError: attempt.kind === 'failed' ? attempt.error : sql`null`,
			...((attempt.kind === 'progressed' ||
				(attempt.kind === 'finished' && attempt.progressed)) && {
				localStepProgressedAt: attempt.at
			})
		})
		.where(eq(d1Schema.tenant.id, tenant));
}

/**
 * Summarises an error for a tenant row, within `localStepErrorMaxLength`.
 */
export function summariseLocalStepError(error: unknown): string {
	const summary =
		error instanceof Error
			? error.message.length > 0
				? `${error.name}: ${error.message}`
				: error.name
			: String(error);

	return summary.slice(0, localStepErrorMaxLength);
}
