import { activityLogRecords, type NixValidPathInfo } from '@cupboard/nix';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import type {
	BuildSubjectV3Input,
	SubjectVerification
} from '@cupboard/protocol/build';
import { z } from 'zod';

/**
An empty `machine` denotes a local build.
*/
export interface BuildActivity {
	readonly derivation: string;
	readonly machine: string;
}

export interface BuildAttempt {
	readonly attempt: number;
	readonly attemptId: string;
	readonly activities: readonly BuildActivity[];
}

// `json-log-path` emits JSON lines. A `start` record with activity type 105
// stores the derivation and dispatched machine in its first two fields.
const buildActivityStartSchema = z.object({
	action: z.literal('start'),
	type: z.literal(105),
	fields: z.tuple([z.string().endsWith('.drv'), z.string()]).rest(z.unknown())
});

/**
Returns the last build-start record for each derivation in a JSON log.
*/
export function parseBuildActivities(log: string): readonly BuildActivity[] {
	const activities = new Map<string, BuildActivity>();

	for (const record of activityLogRecords(log)) {
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
 * The first attempt for a derivation determines its remote builder, matching
 * the attempt used for receipt attribution.
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

function verificationOf(activity: BuildActivity): SubjectVerification {
	return activity.machine === '' ? 'local' : 'build-store';
}

interface FirstBuild {
	readonly attempt: number;
	readonly attemptId: string;
	readonly activity: BuildActivity;
}

/**
 * Attributes each newly realised final path to the first attempt that built
 * its deriver. The subject records the selected build store and whether Nix
 * ran the build locally or delegated it. Paths that predate the run or have no
 * matching build activity retain store-derived provenance.
 */
export function receiptSubjects(
	attempts: readonly BuildAttempt[],
	finalInfos: readonly NixValidPathInfo[],
	preExisting: ReadonlySet<string>,
	buildStore: string
): readonly BuildSubjectV3Input[] {
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
		.flatMap((info): BuildSubjectV3Input[] => {
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
