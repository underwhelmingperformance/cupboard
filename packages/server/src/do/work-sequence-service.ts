import { eq, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import { type SchemaWriter } from './context.ts';

export class WorkSequenceService {
	constructor(private readonly handle: SchemaWriter) {}

	allocate(): number {
		const table = schema.workSequence;
		const [row] = this.handle
			.update(table)
			.set({ value: sql`${table.value} + 1` })
			.where(eq(table.id, 1))
			.returning({ value: table.value })
			.all();
		if (row === undefined) {
			throw new Error('The durable work sequence is unavailable.');
		}
		return row.value;
	}

	current(): number {
		return (
			this.handle
				.select({ value: schema.workSequence.value })
				.from(schema.workSequence)
				.where(eq(schema.workSequence.id, 1))
				.get()?.value ?? 0
		);
	}
}
