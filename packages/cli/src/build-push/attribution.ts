import { activityLogRecords, type NixValidPathInfo } from '@cupboard/nix';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import type { BuildSubjectV3Input } from '@cupboard/protocol/build';
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
	readonly verifiedOutputs?: readonly VerifiedBuildOutput[];
}

export interface VerifiedBuildOutput {
	readonly storePath: string;
	readonly narHash: string;
	readonly derivation: string;
}

// `json-log-path` emits JSON lines. A `start` record with activity type 105
// stores the derivation and dispatched machine in its first two fields.
const buildActivityStartSchema = z.object({
	action: z.literal('start'),
	type: z.literal(105),
	fields: z.tuple([z.string().endsWith('.drv'), z.string()]).rest(z.unknown())
});

/**
Returns build activity for each derivation, preserving any remote dispatch.
*/
export function parseBuildActivities(log: string): readonly BuildActivity[] {
	const activities = new Map<string, BuildActivity>();

	for (const record of activityLogRecords(log)) {
		const start = buildActivityStartSchema.safeParse(record);

		if (!start.success) {
			continue;
		}

		const [derivation, machine] = start.data.fields;
		const previous = activities.get(derivation);

		if (previous !== undefined && previous.machine !== '') {
			continue;
		}

		activities.set(derivation, { derivation, machine });
	}

	return activities
		.values()
		.toArray()
		.toSorted((left, right) => byCodeUnit(left.derivation, right.derivation));
}

interface FirstBuild {
	readonly attempt: number;
	readonly attemptId: string;
	readonly activity: BuildActivity;
}

/**
 * Attributes known outputs to successful local attempts. Callers exclude paths
 * that were valid before the invocation unless a successful rebuild checked
 * them, and supply only attempts that completed successfully.
 */
export function receiptSubjects(
	attempts: readonly BuildAttempt[],
	finalInfos: readonly NixValidPathInfo[],
	preExisting: ReadonlySet<string>,
	buildStore: string
): readonly BuildSubjectV3Input[] {
	const firstBuild = new Map<string, FirstBuild>();

	for (const attempt of attempts) {
		if (attempt.verifiedOutputs !== undefined) {
			continue;
		}

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
			const checked = attempts.find((attempt) =>
				attempt.verifiedOutputs?.some(
					(output) =>
						output.storePath === info.storePath &&
						output.narHash === info.narHash.digestHex() &&
						output.derivation === info.deriver &&
						attempt.activities.some(
							(activity) =>
								activity.derivation === output.derivation &&
								activity.machine === ''
						)
				)
			);
			if (
				info.deriver === undefined ||
				!info.ultimate ||
				(checked === undefined && preExisting.has(info.storePath))
			) {
				return [];
			}

			const original = firstBuild.get(info.deriver);
			const built = checked ?? original;

			if (
				built === undefined ||
				(checked === undefined && original?.activity.machine !== '')
			) {
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
					verification: 'local',
					...(checked !== undefined && { reproduced: true })
				}
			];
		})
		.toSorted((left, right) => byCodeUnit(left.storePath, right.storePath));
}
