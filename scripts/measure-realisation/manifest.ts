import { UsageError } from '@cupboard/shared/errors';
import { z } from 'zod';

import {
	expandComponents,
	type PublishTarget,
	publishTargetsSchema
} from '../../actions/src/publish-plan.ts';

/** A misuse of the fixture: a manifest it cannot read or measure. */
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
 * The manifest this fixture measures: the publish workflow's own `--targets`
 * array, or that same array under a `targets` key, the shape the planner's
 * own targets files carry. Both spellings parse to the array, so a caller
 * points the fixture at the manifest its workflow already uses.
 */
export const measurementManifestSchema = z.union([
	publishTargetsSchema,
	z
		.object({ targets: publishTargetsSchema })
		.transform((manifest) => manifest.targets)
]);

/**
 * The targets a manifest declares, component-publication targets expanded
 * into the components published in their place, so what the fixture measures
 * is what a run would realise.
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

// Every measurement in the report is keyed by its target's attr, and a
// baseline looks a budget up by that key, so two targets sharing one attr
// would overwrite each other's numbers.
function assertDistinctAttributes(targets: readonly PublishTarget[]): void {
	const seen = new Set<string>();

	for (const target of targets) {
		if (seen.has(target.attr)) {
			throw new DuplicateTargetAttributeError(target.attr);
		}

		seen.add(target.attr);
	}
}

/** The targets one `cohort` label puts in a single job. */
export interface TargetGroup {
	readonly key: string;
	readonly attrs: readonly string[];
}

/**
 * The manifest's declared cohorts that hold more than one target, in key
 * order. A target with no `cohort` label is its own cohort, and a cohort of
 * one costs the same measured apart as together, so only the cohorts whose
 * membership makes the comparison meaningful become groups. The key is the
 * manifest's own label, so a baseline written against one manifest keeps
 * naming the same group when the manifest grows.
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
