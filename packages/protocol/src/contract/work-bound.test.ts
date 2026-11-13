import { isContractProcedure } from '@orpc/contract';
import { describe, expect, it } from 'vitest';

import { type WorkBound, workBoundOf } from './base.ts';
import { tenantContract } from './tenant.ts';

/**
The `workBound` of every procedure in `contract`, keyed by the procedure's
dotted path. A procedure without one maps to `undefined`.
*/
function workBounds(
	contract: object,
	prefix: readonly string[] = []
): Record<string, WorkBound | undefined> {
	return Object.fromEntries(
		Object.entries(contract).flatMap(([key, value]: [string, unknown]) => {
			const path = [...prefix, key];

			if (isContractProcedure(value)) {
				return [[path.join('.'), workBoundOf(value)]];
			}

			return typeof value === 'object' && value !== null
				? Object.entries(workBounds(value, path))
				: [];
		})
	);
}

describe('the tenant contract', () => {
	it('classifies the work bound of every procedure', () => {
		expect(workBounds(tenantContract)).toStrictEqual({
			'policies.list': 'size',
			'policies.remove': 'time',
			'policies.graceList': 'size',
			'policies.graceRemove': 'time',
			'caches.defaults.get': 'time',
			'caches.defaults.set': 'time',
			'caches.list': 'time',
			'caches.get.inDefaultCache': 'time',
			'caches.get.inNamedCache': 'time',
			'caches.put.inDefaultCache': 'time',
			'caches.put.inNamedCache': 'time',
			'caches.update.inDefaultCache': 'time',
			'caches.update.inNamedCache': 'time',
			'caches.close': 'time',
			'caches.reopen': 'time',
			'caches.retirement': 'time',
			'caches.remove': 'time',
			'keys.signing.list': 'time',
			'keys.signing.rotate': 'time',
			'keys.signing.retire': 'time',
			'keys.signing.abort': 'time',
			'keys.auth.list': 'time',
			'keys.auth.rotate': 'time',
			'keys.auth.retire': 'time',
			'sessions.list': 'size',
			'sessions.revoke': 'time',
			'reuseViews.list': 'size',
			'reuseViews.set': 'time',
			'reuseViews.remove': 'time',
			'oidcTrust.list': 'size',
			'oidcTrust.get': 'time',
			'oidcTrust.add': 'time',
			'oidcTrust.extend': 'time',
			'oidcTrust.remove': 'time',
			'stats.cache.inDefaultCache': 'time',
			'stats.cache.inNamedCache': 'time',
			'stats.usage': 'time',
			'check.run': 'size',
			'check.sharedAccess': 'time',
			'roots.list.inDefaultCache': 'time',
			'roots.list.inNamedCache': 'time',
			'roots.targets.inDefaultCache': 'size',
			'roots.targets.inNamedCache': 'size',
			'roots.set.inDefaultCache': 'size',
			'roots.set.inNamedCache': 'size',
			'roots.ensure.inDefaultCache': 'size',
			'roots.ensure.inNamedCache': 'size',
			'roots.batch.inDefaultCache': 'size',
			'roots.batch.inNamedCache': 'size',
			'roots.remove.inDefaultCache': 'time',
			'roots.remove.inNamedCache': 'time',
			'paths.remove.inDefaultCache': 'time',
			'paths.remove.inNamedCache': 'time',
			'gc.runAll': 'size',
			'gc.runCache': 'size',
			'verify.run': 'size',
			'uploads.plan.inDefaultCache': 'size',
			'uploads.plan.inNamedCache': 'size',
			'uploads.credential.inDefaultCache': 'time',
			'uploads.credential.inNamedCache': 'time',
			'uploads.negotiate.inDefaultCache': 'size',
			'uploads.negotiate.inNamedCache': 'size',
			'uploads.preview.inDefaultCache': 'size',
			'uploads.preview.inNamedCache': 'size',
			'uploads.confirmPresent.inDefaultCache': 'size',
			'uploads.confirmPresent.inNamedCache': 'size',
			'uploads.confirm.inDefaultCache': 'size',
			'uploads.confirm.inNamedCache': 'size',
			'uploads.status': 'time',
			'attestations.negotiateBundles.inDefaultCache': 'size',
			'attestations.negotiateBundles.inNamedCache': 'size',
			'attestations.attachPaths.inDefaultCache': 'size',
			'attestations.attachPaths.inNamedCache': 'size',
			'attestations.negotiate.inDefaultCache': 'size',
			'attestations.negotiate.inNamedCache': 'size',
			'attestations.attach.inDefaultCache': 'size',
			'attestations.attach.inNamedCache': 'size'
		});
	});
});
