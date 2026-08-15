import { z } from 'zod';

// An ISO-8601 instant. Every timestamp the workspace stores or transmits is
// carried as one of these strings: D1 and Durable Object SQLite sort them
// lexicographically, so ordering and range queries depend on the string form.
//
// The brand narrows nothing at runtime. These schemas parse rows and responses
// that already exist, and an output field that starts rejecting values would
// narrow what an older server is allowed to return (see the compatibility note
// in caches.ts), so the brand stays type-level only.
export const isoTimestampSchema = z.string().brand('IsoTimestamp');
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;

/**
The ISO-8601 rendering of an instant.
*/
export function isoTimestamp(instant: Date): IsoTimestamp {
	return isoTimestampSchema.parse(instant.toISOString());
}
