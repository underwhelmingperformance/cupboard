import {
	cacheGenerationSchema,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { asc, eq, isNull } from 'drizzle-orm';

import { cacheIdentityCondition, cacheScopeFromRow } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { type ServerContext } from '../do/context.ts';
import { CacheIncarnationMigrationError } from '../errors.ts';

/**
 * Copies authoritative cache incarnations into the local cache catalogue.
 *
 * Rows from older incarnations can remain locally while their teardown drains.
 * Work backwards from the D1 generation so each retained row keeps the object
 * namespace which it created. The current live row also receives the D1 read
 * revision used by public Workers Cache keys.
 */
export async function reconcileLocalCacheIncarnations(
	context: ServerContext,
	tenant: TenantId
): Promise<void> {
	const lifecycles = await context.d1
		.select({
			kind: d1Schema.cacheLifecycle.cacheKind,
			name: d1Schema.cacheLifecycle.cacheName,
			access: d1Schema.cacheLifecycle.access,
			generation: d1Schema.cacheLifecycle.generation,
			readRevision: d1Schema.cacheLifecycle.readRevision,
			deletedAt: d1Schema.cacheLifecycle.deletedAt
		})
		.from(d1Schema.cacheLifecycle)
		.where(eq(d1Schema.cacheLifecycle.tenant, tenant))
		.all();

	for (const lifecycle of lifecycles) {
		const scope = cacheScopeFromRow({
			kind: lifecycle.kind,
			name: lifecycle.name
		});
		const localRows = context.db
			.select({ id: schema.caches.id, deletedAt: schema.caches.deletedAt })
			.from(schema.caches)
			.where(
				cacheIdentityCondition(schema.caches.kind, schema.caches.name, scope)
			)
			.orderBy(asc(schema.caches.id))
			.all();
		const liveRows = localRows.filter((row) => row.deletedAt === null);

		if (liveRows.length > 1) {
			throw new CacheIncarnationMigrationError(
				tenant,
				`cache ${JSON.stringify(scope)} has several live local incarnations`
			);
		}

		if (lifecycle.deletedAt === null && liveRows.length !== 1) {
			throw new CacheIncarnationMigrationError(
				tenant,
				`live cache ${JSON.stringify(scope)} has no live local incarnation`
			);
		}

		let generation =
			lifecycle.deletedAt === null
				? lifecycle.generation
				: cacheGenerationSchema.parse(lifecycle.generation - 1);

		const newestFirst = localRows.toReversed();

		for (const [index, row] of newestFirst.entries()) {
			context.db
				.update(schema.caches)
				.set({
					generation,
					...(row.deletedAt === null && {
						access: lifecycle.access,
						readRevision: lifecycle.readRevision
					})
				})
				.where(eq(schema.caches.id, row.id))
				.run();

			if (index < newestFirst.length - 1) {
				generation = cacheGenerationSchema.parse(generation - 1);
			}
		}
	}

	const unexplained = context.db
		.select({
			kind: schema.caches.kind,
			name: schema.caches.name
		})
		.from(schema.caches)
		.where(isNull(schema.caches.deletedAt))
		.all()
		.filter((row) =>
			lifecycles.every(
				(lifecycle) =>
					!(lifecycle.kind === row.kind && lifecycle.name === row.name)
			)
		);

	if (unexplained.length > 0) {
		throw new CacheIncarnationMigrationError(
			tenant,
			`live local caches have no D1 lifecycle: ${JSON.stringify(unexplained)}`
		);
	}
}
