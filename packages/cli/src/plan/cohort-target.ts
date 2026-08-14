import type { NixDerivedPathString } from '@cupboard/nix';
import {
	hasControlCharacter,
	rootNameSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// A target's attr identifies it in operator diagnostics, so a control
// character in it could forge log lines or runner workflow commands.
const attributeSchema = z
	.string()
	.min(1)
	.refine(
		(value) => !hasControlCharacter(value),
		'attr must not contain control characters'
	);

// The daemon wire protocol names a realisation target as a store path
// optionally followed by `^` and the outputs to realise; a cohort's
// installable travels through the targets file in that same shape. The
// output selection is rendered into diagnostics like the attr, so the same
// control-character rule applies to it.
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

	const outputs = value.slice(separator + 1);

	if (outputs === '' || hasControlCharacter(outputs)) {
		ctx.addIssue({
			code: 'custom',
			message: 'not a valid installable (output selection)'
		});

		return z.NEVER;
	}

	return `${parsedBase.data}^${outputs}`;
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
export const cohortTargetSchema = z
	.strictObject({
		attr: attributeSchema,
		installable: cohortInstallableSchema,
		expectedPath: storePathSchema.optional(),
		// The action will materialise and copy this planned derivation closure
		// before asking the selected remote store to realise the installable.
		plannedLocalDerivation: storePathSchema.optional(),
		root: rootNameSchema
	})
	.superRefine((target, ctx) => {
		if (target.plannedLocalDerivation === undefined) {
			return;
		}

		const selector = target.installable.indexOf('^');
		const derivation =
			selector === -1
				? target.installable
				: target.installable.slice(0, selector);

		if (
			!target.plannedLocalDerivation.endsWith('.drv') ||
			target.plannedLocalDerivation !== derivation
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['plannedLocalDerivation'],
				message:
					'local derivation must be the derivation path named by installable'
			});
		}
	});
export type ParsedCohortTarget = z.output<typeof cohortTargetSchema>;

export const cohortPlanInputSchema = z.strictObject({
	targets: z.array(cohortTargetSchema).min(1)
});
export type ParsedCohortPlanInput = z.output<typeof cohortPlanInputSchema>;

// One target as `cupboard plan measure` reads it from its targets file: the
// target identity the caller keys the reported sizes by, and the installable
// whose own substitutable size the store prices. No expected path and no
// root: measurement asks the store what realising the installable would
// require, nothing about retention or the destination.
export const measureTargetSchema = z.strictObject({
	attr: attributeSchema,
	installable: cohortInstallableSchema
});
export type ParsedMeasureTarget = z.output<typeof measureTargetSchema>;

export const measurePlanInputSchema = z.strictObject({
	targets: z.array(measureTargetSchema).min(1)
});
