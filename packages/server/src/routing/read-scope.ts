import { firstCacheGeneration } from '@cupboard/nix-store/scalars';
import { and, eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { type Context } from 'hono';

import { readTenantEntry } from '../control/tenant-membership.ts';
import { cacheIdentityCondition } from '../db/cache.ts';
import { firstCacheReadRevision } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import {
	MetadataScopeChangedError,
	SharedFactsUnavailableError,
	UnauthenticatedError
} from '../errors.ts';
import { guardScopedRead } from '../read/read.ts';

import { tenantServer } from './durable-object.ts';
import { type WorkerHonoEnv } from './hono-env.ts';

export function cacheReadScopeVersion(context: Context<WorkerHonoEnv>): string {
	const version = context.get('cacheVersion');
	return `cache:${String(version.generation)}:${String(version.readRevision)}:${context.get('readScope').access}:${String(context.get('isCacheDeleted'))}`;
}

export async function revalidateCacheReadScope(
	context: Context<WorkerHonoEnv>,
	expected: string,
	scopeChangedError: Error = new MetadataScopeChangedError()
): Promise<void> {
	const database = drizzleD1(context.env.CUPBOARD_DB, { schema: d1Schema });
	const scope = context.get('readScope').scope;
	const tenant = context.get('tenant');
	const query = database
		.select({
			status: d1Schema.tenant.status,
			generation: d1Schema.cacheLifecycle.generation,
			readRevision: d1Schema.cacheLifecycle.readRevision,
			access: d1Schema.cacheLifecycle.access,
			deletedAt: d1Schema.cacheLifecycle.deletedAt
		})
		.from(d1Schema.tenant)
		.leftJoin(
			d1Schema.cacheLifecycle,
			and(
				eq(d1Schema.cacheLifecycle.tenant, d1Schema.tenant.id),
				cacheIdentityCondition(
					d1Schema.cacheLifecycle.cacheKind,
					d1Schema.cacheLifecycle.cacheName,
					scope
				)
			)
		)
		.where(eq(d1Schema.tenant.id, tenant));
	let current;
	try {
		current = await readWithOneRetry(() => query.get());
	} catch (error) {
		throw new SharedFactsUnavailableError(error);
	}
	const actual = `cache:${String(current?.generation ?? firstCacheGeneration)}:${String(current?.readRevision ?? firstCacheReadRevision)}:${current?.access ?? 'private'}:${String(current?.generation === null || current?.generation === undefined || current.deletedAt !== null)}`;
	if (actual !== expected || current?.status !== 'active') {
		throw scopeChangedError;
	}
}

export async function revalidateCacheReadAuthority(
	context: Context<WorkerHonoEnv>
): Promise<void> {
	const scope = context.get('readScope');
	if (scope.access === 'public') {
		return;
	}
	const tenant = context.get('tenant');
	const admission = await readTenantEntry(context.env, tenant, scope.scope);
	if (admission?.entry.status !== 'active') {
		throw new UnauthenticatedError();
	}
	const denied = await guardScopedRead(
		context.req.raw,
		admission.entry,
		scope,
		{
			cacheVerifier: admission.cacheVerifier,
			isTokenAuthorised: (token, cache) =>
				tenantServer(context.env, tenant).authoriseCacheContentRead(
					token,
					cache,
					admission.cache?.isDeleted ?? true
				)
		}
	);
	if (denied !== undefined) {
		throw new UnauthenticatedError();
	}
}
