import { transitionStateSchema } from '@cupboard/protocol/deployment';
import { eq } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';
import { alias } from 'drizzle-orm/sqlite-core';

import {
	PathReadAuthorityMigrationPendingError,
	SharedFactsUnavailableError
} from '../errors.ts';

import * as schema from './d1-schema.ts';
import { readWithOneRetry } from './transient.ts';

const precedingStorage = alias(schema.cacheLifecycle, 'cache_lifecycle');
export type CacheLifecycleWriteTable =
	typeof schema.cacheLifecycle | typeof precedingStorage;

export async function writeCacheLifecycle<T>(
	database: DrizzleD1Database<typeof schema>,
	operation: (table: CacheLifecycleWriteTable) => Promise<T>
): Promise<T> {
	const readTransition = async () => {
		try {
			return await readWithOneRetry(() =>
				database
					.select()
					.from(schema.deploymentTransition)
					.where(
						eq(schema.deploymentTransition.id, 'blob-reference-read-authority')
					)
					.get()
			);
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	};
	const transition = await readTransition();
	const state = transitionStateSchema.safeParse(transition?.state);
	const isContracted =
		transition !== undefined &&
		(transition.state === 'complete' || !state.success);
	if (isContracted) {
		return operation(schema.cacheLifecycle);
	}
	if (transition?.contractedAt !== null) {
		throw new PathReadAuthorityMigrationPendingError();
	}
	try {
		return await operation(precedingStorage);
	} catch (error) {
		const latest = await readTransition();
		if (latest === undefined) {
			throw error;
		}
		if (
			latest.contractedAt !== null ||
			latest.state === 'complete' ||
			!transitionStateSchema.safeParse(latest.state).success
		) {
			throw new PathReadAuthorityMigrationPendingError(error);
		}
		throw error;
	}
}
