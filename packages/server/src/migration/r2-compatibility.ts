import { eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

export interface R2CompatibilityState {
	readonly writeLegacyObjects: boolean;
	readonly readLegacyObjects: boolean;
	readonly mayDeleteLegacyObjects: boolean;
}

export class R2CompatibilityStateMissingError extends Error {
	constructor() {
		super('The deployment R2 compatibility state is missing');
		this.name = 'R2CompatibilityStateMissingError';
	}
}

export async function readR2CompatibilityState(
	database: Database
): Promise<R2CompatibilityState> {
	const state = await database
		.select({
			writes: d1Schema.deploymentRuntimeControl.legacyR2Writes,
			readFallback: d1Schema.deploymentRuntimeControl.legacyR2ReadFallback,
			deletion: d1Schema.deploymentRuntimeControl.legacyR2Deletion
		})
		.from(d1Schema.deploymentRuntimeControl)
		.where(eq(d1Schema.deploymentRuntimeControl.id, 'current'))
		.get();

	if (state === undefined) {
		throw new R2CompatibilityStateMissingError();
	}

	return {
		writeLegacyObjects: state.writes === 'enabled',
		readLegacyObjects: state.readFallback === 'enabled',
		mayDeleteLegacyObjects: state.deletion === 'eligible'
	};
}
