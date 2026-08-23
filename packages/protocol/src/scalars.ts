import { z } from 'zod';

// D1 and Durable Object SQLite order timestamp columns lexicographically.
// Producers must therefore use ISO-8601 strings for every stored or transmitted
// timestamp.
//
// Keep this brand type-only. The schema parses existing rows and responses, and
// runtime validation would narrow the values that an older server may return
// (see the compatibility note in caches.ts).
export const isoTimestampSchema = z.string().brand('IsoTimestamp');
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;

export function isoTimestamp(instant: Date): IsoTimestamp {
	return isoTimestampSchema.parse(instant.toISOString());
}
