import { UsageError } from '@cupboard/shared/errors';
import { z } from 'zod';

import {
	expandComponents,
	type PublishTarget,
	publishTargetsSchema
} from '../../actions/src/publish-plan.ts';

/**
Invalid fixture input: a manifest that cannot be parsed or measured.
*/
export abstract class ManifestError extends UsageError {}

export class ManifestJsonError extends ManifestError {
	constructor(override readonly cause: SyntaxError) {
		super(`The target manifest is not JSON: ${cause.message}`);
		this.name = 'ManifestJsonError';
	}
}

export class ManifestSchemaError extends ManifestError {
	constructor(override readonly cause: z.ZodError) {
		super('The target manifest does not match the publish target schema');
		this.name = 'ManifestSchemaError';
	}
}

export class DuplicateTargetAttributeError extends ManifestError {
	constructor(readonly attribute: string) {
		super(`The target manifest declares ${attribute} more than once`);
		this.name = 'DuplicateTargetAttributeError';
	}
}

/**
 * The target manifest accepted by this fixture. It can be the publish
 * workflow's `--targets` array directly or an object with that array under a
 * `targets` key. Both forms produce the same target list.
 */
export const measurementManifestSchema = z.union([
	publishTargetsSchema,
	z
		.object({ targets: publishTargetsSchema })
		.transform((manifest) => manifest.targets)
]);

/**
 * Parses the manifest targets and expands component-publication targets into
 * the components the workflow would realise.
 */
export function parseManifest(source: string): readonly PublishTarget[] {
	let value: unknown;

	try {
		value = JSON.parse(source);
	} catch (error) {
		throw new ManifestJsonError(
			error instanceof SyntaxError ? error : new SyntaxError(String(error))
		);
	}

	const parsed = measurementManifestSchema.safeParse(value);

	if (!parsed.success) {
		throw new ManifestSchemaError(parsed.error);
	}

	const targets = expandComponents(parsed.data);

	assertDistinctAttributes(targets);

	return targets;
}

// Reports and baselines use the target attr as their key. Reject duplicate
// attributes so one target cannot overwrite another target's measurement.
function assertDistinctAttributes(targets: readonly PublishTarget[]): void {
	const seen = new Set<string>();

	for (const target of targets) {
		if (seen.has(target.attr)) {
			throw new DuplicateTargetAttributeError(target.attr);
		}

		seen.add(target.attr);
	}
}

/**
Targets assigned to the same cohort job.
*/
export interface TargetGroup {
	readonly key: string;
	readonly attrs: readonly string[];
}

/**
 * Returns the manifest cohorts with at least two members, sorted by cohort
 * key. Unlabelled targets form one-member cohorts, which cost the same measured
 * separately or together and do not need a group comparison. The manifest
 * label remains the stable baseline key when targets are added.
 */
export function declaredGroups(
	targets: readonly PublishTarget[]
): readonly TargetGroup[] {
	const byLabel = new Map<string, string[]>();

	for (const target of targets) {
		if (target.cohort === undefined) {
			continue;
		}

		const members = byLabel.get(target.cohort) ?? [];

		members.push(target.attr);
		byLabel.set(target.cohort, members);
	}

	return byLabel
		.entries()
		.filter(([, attributes]) => attributes.length > 1)
		.map(([key, attributes]): TargetGroup => ({ key, attrs: attributes }))
		.toArray()
		.toSorted((left, right) => left.key.localeCompare(right.key));
}
