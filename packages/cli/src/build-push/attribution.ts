import type { NixValidPathInfo } from '@cupboard/nix';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import type { BuildSubject } from '@cupboard/protocol/build';
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

/**
 * Parses a JSON activity log into the build activities it recorded, one per
 * derivation, later records winning. The log is another process's output, so
 * the parse is tolerant: a line that is not JSON, or a record of any other
 * shape, is skipped.
 */
export function parseBuildActivities(log: string): readonly BuildActivity[] {
	const activities = new Map<string, BuildActivity>();

	for (const line of log.split(/\r?\n/u)) {
		if (line === '') {
			continue;
		}

		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}

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
 * The derivations whose outputs need a local re-verification build before they
 * are trusted: every final derivation built on a remote machine, and every one
 * first built in an attempt other than the successful one, whose store state
 * the successful attempt did not itself produce.
 */
export function derivationsRequiringVerification(
	attempts: readonly BuildAttempt[],
	successfulAttempt: number,
	finalInfos: readonly NixValidPathInfo[]
): readonly string[] {
	const finalDerivations = new Set(
		finalInfos.flatMap((info) =>
			info.deriver === undefined ? [] : [info.deriver]
		)
	);
	const derivations = new Set<string>();

	for (const attempt of attempts) {
		for (const activity of attempt.activities) {
			if (
				finalDerivations.has(activity.derivation) &&
				(attempt.attempt !== successfulAttempt || activity.machine !== '')
			) {
				derivations.add(activity.derivation);
			}
		}
	}

	return derivations.values().toArray().toSorted(byCodeUnit);
}

/**
 * The successful attempt's attribution once a verification pass has rebuilt
 * the given derivations locally: each verified derivation's activity is
 * re-recorded as a local build, since the local rebuild is what the run
 * finally trusts.
 */
export function verifiedAttribution(
	attempt: BuildAttempt,
	verified: readonly string[]
): BuildAttempt {
	const activities = new Map(
		attempt.activities.map((activity) => [activity.derivation, activity])
	);

	for (const derivation of verified) {
		activities.set(derivation, { derivation, machine: '' });
	}

	return { ...attempt, activities: activities.values().toArray() };
}

/**
 * The receipt subjects a run's attribution yields: one per final path whose
 * deriver some attempt built, carrying the earliest attempt that produced it.
 * A path that was already valid before the run, or whose deriver no attempt
 * touched, is not this run's subject.
 */
export function receiptSubjects(
	attempts: readonly BuildAttempt[],
	finalInfos: readonly NixValidPathInfo[],
	preExisting: ReadonlySet<string>
): readonly BuildSubject[] {
	const firstBuild = new Map<string, Omit<BuildAttempt, 'activities'>>();

	for (const attempt of attempts) {
		for (const activity of attempt.activities) {
			if (!firstBuild.has(activity.derivation)) {
				firstBuild.set(activity.derivation, attempt);
			}
		}
	}

	return finalInfos
		.flatMap((info) => {
			if (info.deriver === undefined || preExisting.has(info.storePath)) {
				return [];
			}

			const built = firstBuild.get(info.deriver);

			if (built === undefined) {
				return [];
			}

			return [
				{
					storePath: info.storePath,
					narHash: info.narHash.digestHex(),
					derivation: info.deriver,
					attempt: built.attempt,
					attemptId: built.attemptId
				}
			];
		})
		.toSorted((left, right) => byCodeUnit(left.storePath, right.storePath));
}
