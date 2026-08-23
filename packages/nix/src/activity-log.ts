import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// Nix emits `actCopyPath` (100) only after it has confirmed that the destination
// lacks the path and the transfer has begun. Its first three fields are the
// store path, source store and destination store, so the event proves this run
// started fetching the path from that source. Activity type 108 is emitted
// before the destination check and can also appear for an existing path.
const copyActivityStartSchema = z.object({
	action: z.literal('start'),
	type: z.literal(100),
	fields: z
		.tuple([storePathSchema, z.string().min(1), z.string().min(1)])
		.rest(z.unknown())
});

/**
 * Parses the records in one `json-log-path` file. Nix writes one JSON document
 * per line. The file comes from another process, so malformed lines are skipped
 * and each caller ignores unrecognised record types.
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
 * Extracts copy evidence from the supplied activity logs. Each map entry lists
 * the source stores from this run's `actCopyPath` events, deduplicated in log
 * order. Several sources mean that Nix started more than one transfer for the
 * path, for example after a fetch failed.
 *
 * The map omits paths with no copy event in these logs. This includes paths
 * that were already valid and copies performed outside these invocations.
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
