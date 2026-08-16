import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// A copy starting is an `action: 'start'` record of activity type 100 whose
// fields are the store path, the store the bytes are read from and the store
// they are written to. Nix writes the record once the transfer begins, which is
// after it has checked that the destination does not already hold the path, so
// the record shows that this run really did fetch the path from that source.
// Type 108 names the substituter a substitution chose, but Nix writes that
// record before the check, so it also appears for a path the destination turns
// out to hold already.
const copyActivityStartSchema = z.object({
	action: z.literal('start'),
	type: z.literal(100),
	fields: z
		.tuple([storePathSchema, z.string().min(1), z.string().min(1)])
		.rest(z.unknown())
});

/**
 * The records in one `json-log-path` file, which Nix writes as one JSON
 * document per line. The file is another process's output, so reading it is
 * tolerant: a line that is not JSON is skipped, and each caller ignores the
 * records it does not recognise.
 */
export function* activityLogRecords(log: string): Generator {
	for (const line of log.split(/\r?\n/u)) {
		if (line === '') {
			continue;
		}

		try {
			yield JSON.parse(line);
		} catch {
			continue;
		}
	}
}

/**
 * The stores a run copied each path from, keyed by store path, in the order the
 * logs recorded them. A path has more than one source when the run copied it
 * more than once, which happens when Nix moves on to the next substituter after
 * a fetch fails.
 *
 * A path the run never copied has no entry. That covers every path the store
 * already held when the run started, and every path some other store fetched
 * where this run could not see it.
 */
export function copySources(
	logs: readonly string[]
): ReadonlyMap<StorePathString, readonly string[]> {
	const sources = new Map<StorePathString, string[]>();

	for (const log of logs) {
		recordCopySources(log, sources);
	}

	return sources;
}

function recordCopySources(
	log: string,
	sources: Map<StorePathString, string[]>
): void {
	for (const record of activityLogRecords(log)) {
		const start = copyActivityStartSchema.safeParse(record);

		if (!start.success) {
			continue;
		}

		const [storePath, source] = start.data.fields;
		const recorded = sources.get(storePath) ?? [];

		if (!recorded.includes(source)) {
			recorded.push(source);
		}

		sources.set(storePath, recorded);
	}
}
