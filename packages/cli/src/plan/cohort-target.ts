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
// optionally followed by `^` and the outputs to realise, and a cohort's
// installable is written in the targets file in that same form. The output
// selection is rendered into diagnostics like the attr, so the same
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
// can predict it before building, and the retention root the target's own
// `roots.ensure` call names. This is the file `build-cohort` writes
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

function isSingleDerivationOutput(installable: string): boolean {
	const selection = installable.indexOf('^');
	const outputName = installable.slice(selection + 1);

	return (
		selection > 0 &&
		installable.slice(0, selection).endsWith('.drv') &&
		outputName.length > 0 &&
		outputName !== '*' &&
		!outputName.includes(',') &&
		!outputName.includes('^')
	);
}

const plannedLocalOutputSchema = z.strictObject({
	path: storePathSchema,
	installable: cohortInstallableSchema.refine(
		isSingleDerivationOutput,
		'local output installable must select a derivation output'
	)
});

const plannedFloatingOutputSchema = cohortInstallableSchema.refine(
	isSingleDerivationOutput,
	'floating output installable must select one derivation output'
);

/**
An output whose path is declared by a derivation in the local graph.
*/
export type ParsedPlannedLocalOutput = z.output<
	typeof plannedLocalOutputSchema
>;

/**
The targets file schema for initial cohort planning.
*/
export const cohortPlanInputSchema = z
	.strictObject({
		targets: z.array(cohortTargetSchema).min(1),
		// Paths available for copying to the selected remote store. The plan records
		// which remote targets require each path, and the action copies only those
		// retained after the final availability check.
		plannedLocalClosure: z.array(storePathSchema).optional(),
		// Derivations that permit substitution. A remote availability query can stop
		// at a derivation that has not been copied yet, so the planner uses this list
		// when it checks whether the known outputs can be substituted instead.
		plannedSubstitutableDerivations: z.array(storePathSchema).optional(),
		// Output selections whose derivations do not declare a store path. A
		// narinfo does not provide the realisation mapping that the selected store
		// needs for these derived paths.
		plannedFloatingOutputs: z.array(plannedFloatingOutputSchema).optional(),
		// The action can realise each output after copying its derivation. The path
		// identifies the output and the installable specifies how to produce it.
		plannedLocalOutputs: z.array(plannedLocalOutputSchema).optional()
	})
	.superRefine((input, ctx) => {
		const copiedPaths = new Set(input.plannedLocalClosure);
		const substitutableDerivations =
			input.plannedSubstitutableDerivations ?? [];

		for (const [index, derivation] of substitutableDerivations.entries()) {
			if (!derivation.endsWith('.drv') || !copiedPaths.has(derivation)) {
				ctx.addIssue({
					code: 'custom',
					path: ['plannedSubstitutableDerivations', index],
					message: 'substitutable derivation is absent from plannedLocalClosure'
				});
			}
		}

		const floatingOutputs = input.plannedFloatingOutputs ?? [];

		for (const [index, installable] of floatingOutputs.entries()) {
			const derivation = storePathSchema.parse(
				installable.slice(0, installable.indexOf('^'))
			);

			if (!copiedPaths.has(derivation)) {
				ctx.addIssue({
					code: 'custom',
					path: ['plannedFloatingOutputs', index],
					message:
						'floating output derivation is absent from plannedLocalClosure'
				});
			}
		}

		if (input.plannedLocalOutputs === undefined) {
			return;
		}

		const plannedLocalOutputs = input.plannedLocalOutputs.entries();

		for (const [index, output] of plannedLocalOutputs) {
			const selection = output.installable.indexOf('^');
			const selectedPath = output.installable.slice(0, selection);

			if (!selectedPath.endsWith('.drv')) {
				continue;
			}

			const derivation = storePathSchema.parse(selectedPath);

			if (!copiedPaths.has(derivation)) {
				ctx.addIssue({
					code: 'custom',
					path: ['plannedLocalOutputs', index, 'installable'],
					message: 'local output derivation is absent from plannedLocalClosure'
				});
			}
		}
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
