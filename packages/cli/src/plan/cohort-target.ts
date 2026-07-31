import type { NixDerivedPathString } from '@cupboard/nix';
import { rootNameSchema, storePathSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// The daemon wire protocol names a realisation target as a store path
// optionally followed by `^` and the outputs to realise; a cohort's
// installable travels through the targets file in that same shape.
function parseInstallable(
	value: string,
	ctx: z.RefinementCtx
): NixDerivedPathString {
	const separator = value.indexOf('^');
	const basePath = separator === -1 ? value : value.slice(0, separator);
	const parsedBase = storePathSchema.safeParse(basePath);

	if (!parsedBase.success) {
		ctx.addIssue({
			code: 'custom',
			message: `not a valid installable (store path): ${basePath}`
		});

		return z.NEVER;
	}

	if (separator === -1) {
		return parsedBase.data;
	}

	return `${parsedBase.data}^${value.slice(separator + 1)}`;
}

export const cohortInstallableSchema = z
	.string()
	.min(1)
	.transform(parseInstallable);

// One cohort member as `cupboard plan cohort` reads it from its targets
// file: what `nix build` would realise, the concrete output path when Nix
// can predict it before building, and the retention root that target's own
// `roots.ensure` call answers for. This is the file `build-cohort` writes
// from a plan job's cohort-matrix entry, so it stays a plain, file-portable
// shape rather than the branded `AvailabilityTarget` the partition itself
// consumes.
export const cohortTargetSchema = z.strictObject({
	attr: z.string().min(1),
	installable: cohortInstallableSchema,
	expectedPath: storePathSchema.optional(),
	root: rootNameSchema
});
export type ParsedCohortTarget = z.output<typeof cohortTargetSchema>;

export const cohortPlanInputSchema = z.strictObject({
	targets: z.array(cohortTargetSchema).min(1)
});
export type ParsedCohortPlanInput = z.output<typeof cohortPlanInputSchema>;
