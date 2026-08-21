import type {
	ConfiguredInstanceSummary,
	InstanceName
} from '@cupboard/protocol/instance';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import { eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { InstanceAlreadyInitialisedError } from '../errors.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

const singletonId = 'singleton';

export async function readInstanceConfig(
	database: Database
): Promise<ConfiguredInstanceSummary | undefined> {
	const configured = await database
		.select({ name: d1Schema.instanceConfig.name })
		.from(d1Schema.instanceConfig)
		.where(eq(d1Schema.instanceConfig.id, singletonId))
		.get();

	return configured === undefined
		? undefined
		: { state: 'configured', name: configured.name };
}

export async function initialiseInstanceConfig(
	database: Database,
	name: InstanceName,
	createdAt: IsoTimestamp
): Promise<ConfiguredInstanceSummary> {
	await database
		.insert(d1Schema.instanceConfig)
		.values({ id: singletonId, name, createdAt })
		.onConflictDoNothing()
		.run();

	const configured = await readInstanceConfig(database);

	if (configured?.name !== name) {
		throw new InstanceAlreadyInitialisedError();
	}

	return configured;
}
