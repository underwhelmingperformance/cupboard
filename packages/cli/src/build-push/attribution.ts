import type { NixValidPathInfo } from '@cupboard/nix';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import type {
	BuildSubjectV3,
	SubjectVerification
} from '@cupboard/protocol/build';
import { z } from 'zod';

/**
 * One build activity a JSON activity log attributed: the derivation that ran,
 * the machine it ran on, and whether a local rebuild has since reproduced its
 * outputs. An empty machine is a local build; a non-empty one names the remote
 * builder that produced the outputs.
 */
export interface BuildActivity {
	readonly derivation: string;
	readonly machine: string;
	readonly verified: boolean;
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
		activities.set(derivation, { derivation, machine, verified: false });
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
 * The attempts' attribution once a verification pass has rebuilt the given
 * derivations locally: each derivation's first recorded activity is marked as
 * reproduced, preserving the attempt and machine that first produced it. A
 * derivation no attempt recorded is left unattributed.
 */
export function verifiedAttribution(
	attempts: readonly BuildAttempt[],
	verified: readonly string[]
): readonly BuildAttempt[] {
	const pending = new Set(verified);

	return attempts.map((attempt) => ({
		...attempt,
		activities: attempt.activities.map((activity) => {
			if (!pending.delete(activity.derivation)) {
				return activity;
			}

			return { ...activity, verified: true };
		})
	}));
}

// How far a build activity establishes that its outputs are this run's. A local
// rebuild is what the run finally trusts, so a reproduced activity reads as
// verified whatever machine first ran it; an unreproduced remote build is
// attributed to that machine and nothing more.
function verificationOf(activity: BuildActivity): SubjectVerification {
	if (activity.verified) {
		return 'verified-rebuild';
	}

	return activity.machine === '' ? 'local' : 'unverified';
}

// One derivation's first build within a run: the attempt that ran it and the
// activity that attempt recorded for it.
interface FirstBuild {
	readonly attempt: number;
	readonly attemptId: string;
	readonly activity: BuildActivity;
}

/**
 * The receipt subjects a run's attribution yields: one per final path whose
 * deriver some attempt built, carrying the earliest attempt that produced it,
 * the store the run realised it in, and how far the build was established. A
 * path that was already valid before the run, or whose deriver no attempt
 * touched, is not this run's subject.
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
