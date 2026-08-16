import type { NixValidPathInfo } from '@cupboard/nix';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type BuildSubjectV3,
	type NixStoreUri,
	nixStoreUriSchema,
	type SubjectVerification
} from '@cupboard/protocol/build';
import { z } from 'zod';

/**
 * One build activity a JSON activity log attributed: the derivation that ran
 * and the machine it ran on. An empty machine is a local build; a non-empty
 * one names the remote builder that produced the outputs.
 */
export interface BuildActivity {
	readonly derivation: string;
	readonly machine: string;
}

/**
 * One build attempt's attribution: its ordinal within the run, the identifier
 * the receipt names it by, and the activities its log recorded.
 */
export interface BuildAttempt {
	readonly attempt: number;
	readonly attemptId: string;
	readonly activities: readonly BuildActivity[];
}

// Nix's `json-log-path` writes one JSON record per line; a build starting is
// an `action: 'start'` record of activity type 105 whose first two fields are
// the derivation and the machine it was dispatched to.
const buildActivityStartSchema = z.object({
	action: z.literal('start'),
	type: z.literal(105),
	fields: z.tuple([z.string().endsWith('.drv'), z.string()]).rest(z.unknown())
});

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
		.tuple([storePathSchema, nixStoreUriSchema, nixStoreUriSchema])
		.rest(z.unknown())
});

// The log is another process's output, so reading it is tolerant: a line that
// is not JSON is skipped, and each caller ignores the records it does not
// recognise.
function* logRecords(log: string): Generator {
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
 * Parses a JSON activity log into the build activities it recorded, one per
 * derivation, later records winning.
 */
export function parseBuildActivities(log: string): readonly BuildActivity[] {
	const activities = new Map<string, BuildActivity>();

	for (const record of logRecords(log)) {
		const start = buildActivityStartSchema.safeParse(record);

		if (!start.success) {
			continue;
		}

		const [derivation, machine] = start.data.fields;
		activities.set(derivation, { derivation, machine });
	}

	return activities
		.values()
		.toArray()
		.toSorted((left, right) => byCodeUnit(left.derivation, right.derivation));
}

/**
 * The stores this run copied each path from, keyed by store path, in the order
 * the logs recorded them. A path has more than one source when the run copied it
 * more than once, which happens when Nix moves on to the next substituter after
 * a fetch fails.
 *
 * A path the run never copied has no entry. That covers every path the store
 * already held when the run started, and every path some other store fetched
 * where this run could not see it.
 */
export function copySources(
	logs: readonly string[]
): ReadonlyMap<StorePathString, readonly NixStoreUri[]> {
	const sources = new Map<StorePathString, NixStoreUri[]>();

	for (const log of logs) {
		recordCopySources(log, sources);
	}

	return sources;
}

function recordCopySources(
	log: string,
	sources: Map<StorePathString, NixStoreUri[]>
): void {
	for (const record of logRecords(log)) {
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

/**
 * The builder for each derivation a builder built, keyed by derivation path.
 * A derivation built locally has no entry. When several attempts record the
 * same derivation, the entry is the builder from the earliest attempt, which
 * is also the attempt the receipt subject records.
 */
export function delegatedMachines(
	attempts: readonly BuildAttempt[]
): ReadonlyMap<string, string> {
	const machines = new Map<string, string>();

	for (const attempt of attempts) {
		for (const activity of attempt.activities) {
			if (activity.machine !== '' && !machines.has(activity.derivation)) {
				machines.set(activity.derivation, activity.machine);
			}
		}
	}

	return machines;
}

// An empty machine means Nix ran the build here; any other value is the
// builder that ran it for this run.
function verificationOf(activity: BuildActivity): SubjectVerification {
	return activity.machine === '' ? 'local' : 'build-store';
}

// One derivation's first build within a run: the attempt that ran it and the
// activity that attempt recorded for it.
interface FirstBuild {
	readonly attempt: number;
	readonly attemptId: string;
	readonly activity: BuildActivity;
}

/**
 * The receipt subjects for a run's attribution: one per final path whose
 * deriver some attempt built. Each subject carries the earliest attempt that
 * produced the path, the store the run realised it in, and whether Nix built
 * the path on this machine or a builder built it for this run. A path that was
 * already valid before the run, or whose deriver no attempt touched, is not a
 * path this run built, and the publication describes it from what the store
 * records about it instead.
 */
export function receiptSubjects(
	attempts: readonly BuildAttempt[],
	finalInfos: readonly NixValidPathInfo[],
	preExisting: ReadonlySet<string>,
	buildStore: string
): readonly BuildSubjectV3[] {
	const firstBuild = new Map<string, FirstBuild>();

	for (const attempt of attempts) {
		for (const activity of attempt.activities) {
			if (!firstBuild.has(activity.derivation)) {
				firstBuild.set(activity.derivation, {
					attempt: attempt.attempt,
					attemptId: attempt.attemptId,
					activity
				});
			}
		}
	}

	return finalInfos
		.flatMap((info): BuildSubjectV3[] => {
			if (info.deriver === undefined || preExisting.has(info.storePath)) {
				return [];
			}

			const built = firstBuild.get(info.deriver);

			if (built === undefined) {
				return [];
			}

			return [
				{
					origin: 'built',
					storePath: info.storePath,
					narHash: info.narHash.digestHex(),
					derivation: info.deriver,
					attempt: built.attempt,
					attemptId: built.attemptId,
					buildStore,
					...(built.activity.machine !== '' && {
						machine: built.activity.machine
					}),
					verification: verificationOf(built.activity)
				}
			];
		})
		.toSorted((left, right) => byCodeUnit(left.storePath, right.storePath));
}
