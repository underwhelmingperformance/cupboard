import { type LocalStepStatus } from '@cupboard/protocol/deployment';
import { formatTimestamp } from '@cupboard/reporter';

type StalledTenant = LocalStepStatus['stalledSample'][number];
type UnwokenTenant = LocalStepStatus['unwokenSample'][number];

/**
 * Describes a stalled tenant: when its object last attempted the work, when
 * it last made progress, and the error of the last attempt or the reason that
 * the object gave up.
 */
export function stalledTenantText(tenant: StalledTenant): string {
	const attempted =
		tenant.attemptedAt === undefined
			? 'no attempt at the outstanding work'
			: `attempted ${formatTimestamp(tenant.attemptedAt)}`;
	const progressed =
		tenant.progressedAt === undefined
			? 'never progressed'
			: `last progress ${formatTimestamp(tenant.progressedAt)}`;
	const error = tenant.error === undefined ? '' : `, ${tenant.error}`;

	return `${tenant.tenant}: ${attempted}, ${progressed}${error}`;
}

/**
 * Describes an unwoken tenant: when its object last attempted the outstanding
 * work, if it has since the tenant last recorded a step.
 */
export function unwokenTenantText(tenant: UnwokenTenant): string {
	return tenant.attemptedAt === undefined
		? `${tenant.tenant}: no attempt at the outstanding work`
		: `${tenant.tenant}: last attempted ${formatTimestamp(tenant.attemptedAt)}`;
}

/**
 * The pending count and how it divides into the three classes.
 */
export function pendingText(status: LocalStepStatus): string {
	return `${String(status.pending)} (working ${String(status.working)}, stalled ${String(status.stalled)}, unwoken ${String(status.unwoken)})`;
}
