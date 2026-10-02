import type { CacheCreationDefaults } from '@cupboard/protocol/caches';
import { eq, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { assertRetentionMigrationSettled } from '../migration/cache-retention.ts';

import type { ServerContext } from './context.ts';

export class CacheCreationDefaultsService {
	constructor(private readonly context: ServerContext) {}

	get(): CacheCreationDefaults {
		const graceSeconds = this.context.db
			.select({ graceSeconds: schema.cacheCreationDefaults.graceSeconds })
			.from(schema.cacheCreationDefaults)
			.where(eq(schema.cacheCreationDefaults.id, 1))
			.get()?.graceSeconds;

		return {
			grace:
				graceSeconds === null || graceSeconds === undefined
					? { kind: 'none' }
					: { kind: 'duration', graceSeconds }
		};
	}

	set(configuration: CacheCreationDefaults): Promise<CacheCreationDefaults> {
		return this.context.criticalSection(() => {
			assertRetentionMigrationSettled(this.context.db);
			const graceSeconds =
				configuration.grace.kind === 'duration'
					? configuration.grace.graceSeconds
					: sql`NULL`;
			this.context.db
				.insert(schema.cacheCreationDefaults)
				.values({ id: 1, graceSeconds })
				.onConflictDoUpdate({
					target: schema.cacheCreationDefaults.id,
					set: { graceSeconds }
				})
				.run();
			return Promise.resolve(this.get());
		});
	}
}
