import { storePathSchema } from '@cupboard/nix-store/scalars';
import { hasControlCharacter, trimSlashes } from '@cupboard/shared/text';
import { z } from 'zod';

// The plan action writes the publish plan as a JSON document, and later steps
// read it back. A reader may come from a different cupboard release than the
// writer, so the document records the version of its shape. Increase the
// version whenever a change would make an older reader misread the document.
export const publishPlanVersion = 1;

// Strip only leading and trailing slashes. Equivalent suffix spellings must
// produce the same root, while interior slashes remain significant.
export function canonicalRootSuffix(suffix: string): string {
	return trimSlashes(suffix);
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

const derivationToTargetsEntrySchema = z.strictObject({
	drvPath: z.string().min(1),
	targets: z.array(z.string().min(1)).readonly()
});
export type DerivationToTargetsEntry = z.output<
	typeof derivationToTargetsEntrySchema
>;

const publishPlanSchema = z.strictObject({
	retained: z.array(publishTargetSchema).readonly(),
	targets: z.array(publishTargetSchema).readonly(),
	cohorts: z.array(cohortSchema).readonly(),
	derivationToTargets: z.array(derivationToTargetsEntrySchema).readonly()
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
export const publishPlanDocumentSchema = publishPlanSchema.extend({
	version: z.literal(publishPlanVersion),
	cohortPreFilter: z.array(cohortPreFilterDecisionSchema).readonly(),
	referencePublications: z
		.array(planReferenceOutcomeSchema)
		.min(1)
		.readonly()
		.optional()
});
export type PublishPlanDocument = z.output<typeof publishPlanDocumentSchema>;
