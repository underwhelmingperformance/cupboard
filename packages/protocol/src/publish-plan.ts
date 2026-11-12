import {
	type RootName,
	rootNameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import {
	hasControlCharacter,
	trimSlashes,
	trimTrailingSlashes
} from '@cupboard/shared/text';
import { z } from 'zod';

import { rootSetMaxTargets } from './retention.ts';

// The plan action writes the publish plan as a JSON document, and later steps
// read it back. A reader may come from a different cupboard release than the
// writer, so the document records the version of its shape. Increase the
// version whenever a change would make an older reader misread the document.
export const publishPlanVersion = 2;

/**
The version of each publish workflow document that a cupboard release reads,
as `cupboard document-versions` prints it. An action hands a document to the
CLI only when the CLI reads the version that the action writes. A field is
absent when the release reads no such document.
*/
export const documentVersionsSchema = z.looseObject({
	publishPlan: z.number().int().optional(),
	cohortRoots: z.number().int().optional()
});
export type DocumentVersions = z.output<typeof documentVersionsSchema>;

// Strip only leading and trailing slashes. Equivalent suffix spellings must
// produce the same root, while interior slashes remain significant.
export function canonicalRootSuffix(suffix: string): string {
	return trimSlashes(suffix);
}

/**
Joins the plan's root prefix and a target's root suffix into the target's root
name. The plan job and the cohort jobs must construct byte-identical names, so
every consumer uses this function.
*/
export function joinRoot(prefix: string, suffix: string): string {
	return `${trimTrailingSlashes(prefix)}/${canonicalRootSuffix(suffix)}`;
}

/**
GitHub compares runner labels case-insensitively with .NET's ordinal rules.
JavaScript's full case conversion differs outside ASCII, so manifest parsing
permits only printable ASCII labels without spaces.
*/
export function isValidRunnerLabel(label: string): boolean {
	return /^[!-~]+$/u.test(label);
}

/**
Reject a leading hyphen so Nix cannot parse a positional input as an option.
These values later enter Nix through newline-delimited stdin, so reject
control characters that could create another installable.
*/
export function isNixPositionalArgument(value: string): boolean {
	return !value.startsWith('-') && !hasControlCharacter(value);
}

const derivationPathSchema = storePathSchema.refine(
	(value) => value.endsWith('.drv'),
	{ message: 'rootDrvPath must name a derivation in /nix/store' }
);

// Bound cohort labels because they become part of matrix job keys.
export const cohortLabelMaxLength = 100;

const publishOutputsSchema = z
	.array(
		z.string().min(1).refine(isNixPositionalArgument, {
			message:
				'output must not start with a hyphen or contain control characters'
		})
	)
	.min(1)
	.default(['out'])
	.transform((outputs) => [...new Set(outputs)]);

/**
Component entries inherit the aggregate target's execution context,
retention root, failure policy and cohort. The plan action replaces each
aggregate target with its components before it plans the cohorts.
*/
export const publishComponentSchema = z.strictObject({
	attr: z.string().min(1).refine(isNixPositionalArgument, {
		message: 'attr must not start with a hyphen or contain control characters'
	}),
	rootDrvPath: derivationPathSchema.optional(),
	outputs: publishOutputsSchema
});
export type PublishComponent = z.output<typeof publishComponentSchema>;

export const publishTargetSchema = z.strictObject({
	attr: z.string().min(1).refine(isNixPositionalArgument, {
		message: 'attr must not start with a hyphen or contain control characters'
	}),
	rootDrvPath: derivationPathSchema.optional(),
	system: z.string().min(1),
	os: z.string().min(1).refine(isValidRunnerLabel, {
		message: 'os must be a printable ASCII runner label without spaces'
	}),
	remote: z.boolean().default(false),
	bestEffort: z.boolean().default(false),
	rootSuffix: z
		.string()
		.min(1)
		.refine((value) => canonicalRootSuffix(value) !== '', {
			message: 'root suffix must contain more than slashes'
		}),
	outputs: publishOutputsSchema,
	// Targets with the same cohort label form one cohort. A target without a
	// label forms its own cohort, keyed by its identity.
	cohort: z
		.string()
		.min(1)
		.max(cohortLabelMaxLength)
		.refine(isValidRunnerLabel, {
			message: `cohort must be a printable ASCII label of at most ${String(cohortLabelMaxLength)} characters without spaces`
		})
		.optional(),
	// When components are present, do not evaluate or build this target's own
	// attr and rootDrvPath. Publish its components under its rootSuffix instead.
	components: z.array(publishComponentSchema).min(1).optional()
});
export type PublishTarget = z.output<typeof publishTargetSchema>;

// Retention treats all targets sharing a root as retained after one successful
// ensure. Duplicate roots could therefore race or cause an uncached target to
// be skipped. Check canonical suffixes so `app`, `/app` and `app/` conflict.
export const publishTargetsSchema = z
	.array(publishTargetSchema)
	.min(1)
	.superRefine((targets, ctx) => {
		const firstBySuffix = new Map<
			string,
			{ readonly index: number; readonly spelling: string }
		>();

		for (const [index, target] of targets.entries()) {
			const canonical = canonicalRootSuffix(target.rootSuffix);
			const first = firstBySuffix.get(canonical);

			if (first === undefined) {
				firstBySuffix.set(canonical, {
					index,
					spelling: target.rootSuffix
				});
				continue;
			}

			ctx.addIssue({
				code: 'custom',
				path: [index, 'rootSuffix'],
				message: `duplicate rootSuffix '${target.rootSuffix}': names the same root as '${first.spelling}' on target ${String(first.index)}`
			});
		}
	})
	.transform((targets) =>
		targets.map((target) => ({
			...target,
			rootSuffix: canonicalRootSuffix(target.rootSuffix)
		}))
	);

/**
Targets in one cohort run in one job. A target without an explicit `cohort`
label forms its own cohort. Cohorts partition the complete manifest before
destination availability is checked, so retained targets remain members.
*/
const cohortSchema = z.strictObject({
	key: z.string().min(1),
	system: z.string().min(1),
	os: z.string().min(1),
	remote: z.boolean(),
	targets: z.array(publishTargetSchema).readonly(),
	installables: z.array(z.string().min(1)).readonly()
});
export type Cohort = z.output<typeof cohortSchema>;

/**
A target that the destination already retains. `paths` contains the evaluated
path of each selected output, which the plan job retains under the target's
root.
*/
const retainedTargetSchema = publishTargetSchema.extend({
	paths: z.array(storePathSchema).min(1).readonly()
});
export type RetainedTarget = z.output<typeof retainedTargetSchema>;

const publishPlanSchema = z.strictObject({
	retained: z.array(retainedTargetSchema).readonly(),
	targets: z.array(publishTargetSchema).readonly(),
	cohorts: z.array(cohortSchema).readonly()
});
export type PublishPlan = z.output<typeof publishPlanSchema>;

const cohortPreFilterDecisionSchema = z.strictObject({
	key: z.string().min(1),
	pruned: z.boolean(),
	reason: z.string().optional()
});
export type CohortPreFilterDecision = z.output<
	typeof cohortPreFilterDecisionSchema
>;

const planReferenceOutcomeSchema = z.strictObject({
	attr: z.string().min(1),
	root: z.string().min(1),
	source: z.string().min(1),
	paths: z.array(storePathSchema).readonly(),
	status: z.enum(['published', 'unavailable', 'failed']),
	reason: z.string().optional()
});
export type PlanReferenceOutcome = z.output<typeof planReferenceOutcomeSchema>;

/**
The document that the plan action writes to its `plan-file` output. A reader
parses it with this schema, which refuses a document of any other version.
*/
export const publishPlanDocumentSchema = publishPlanSchema
	.extend({
		version: z.literal(publishPlanVersion),
		rootPrefix: z.string().min(1),
		cohortPreFilter: z.array(cohortPreFilterDecisionSchema).readonly(),
		referencePublications: z
			.array(planReferenceOutcomeSchema)
			.min(1)
			.readonly()
			.optional()
	})
	.superRefine((document, ctx) => {
		for (const [index, target] of document.retained.entries()) {
			const root = joinRoot(document.rootPrefix, target.rootSuffix);

			if (!rootNameSchema.safeParse(root).success) {
				ctx.addIssue({
					code: 'custom',
					path: ['retained', index, 'rootSuffix'],
					message: `'${root}' is not a valid root name`
				});
			}
		}
	});
export type PublishPlanDocument = z.output<typeof publishPlanDocumentSchema>;

/**
One retention root of a plan's retained targets, with its targets.
*/
export interface RetainedRoot {
	readonly name: RootName;
	readonly targets: readonly StorePathString[];
}

/**
Returns the roots of a plan's retained targets in the order of their first
target. The components of an aggregate target share its root, so a root's
targets are the union of the paths of every retained target with its suffix.
*/
export function retainedRoots(
	document: Pick<PublishPlanDocument, 'rootPrefix' | 'retained'>
): readonly RetainedRoot[] {
	const groups = Map.groupBy(document.retained, (target) =>
		joinRoot(document.rootPrefix, target.rootSuffix)
	);

	return groups
		.entries()
		.map(([name, targets]) => ({
			name: rootNameSchema.parse(name),
			targets: [...new Set(targets.flatMap((target) => target.paths))]
		}))
		.toArray();
}

// A cohort job writes the roots of one `cupboard push` invocation to a JSON
// document, and the push sets them. The two come from the same cupboard
// release only when the workflow builds cupboard from source, so the document
// records the version of its shape, as the plan document does.
export const cohortRootsVersion = 1;

const cohortRootSchema = z.discriminatedUnion('action', [
	// Replace the root's targets with `targets`, which may be empty.
	z.strictObject({
		action: z.literal('set'),
		name: rootNameSchema,
		targets: z.array(storePathSchema).max(rootSetMaxTargets).readonly()
	}),
	// Leave the root as it is, because some of its targets failed.
	z.strictObject({ action: z.literal('unchanged'), name: rootNameSchema })
]);
export type CohortRoot = z.output<typeof cohortRootSchema>;
export type CohortRootInput = z.input<typeof cohortRootSchema>;

/**
The roots that one cohort push sets after it has published every path, and the
roots that it leaves unchanged. Each root appears once.
*/
export const cohortRootsDocumentSchema = z.strictObject({
	version: z.literal(cohortRootsVersion),
	roots: z
		.array(cohortRootSchema)
		.min(1)
		.readonly()
		.superRefine((roots, ctx) => {
			const seen = new Set<string>();

			for (const [index, root] of roots.entries()) {
				if (seen.has(root.name)) {
					ctx.addIssue({
						code: 'custom',
						path: [index, 'name'],
						message: `root '${root.name}' appears more than once`
					});
				}

				seen.add(root.name);
			}
		})
});
export type CohortRootsDocument = z.output<typeof cohortRootsDocumentSchema>;
