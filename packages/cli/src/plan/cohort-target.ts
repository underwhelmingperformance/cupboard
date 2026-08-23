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

// This file format crosses the plan and build jobs, so it uses plain serialised
// values rather than the planner's branded in-memory types.
export const cohortTargetSchema = z
	.strictObject({
		attr: attributeSchema,
		installable: cohortInstallableSchema,
		expectedPath: storePathSchema.optional(),
		// Copy this derivation closure before asking the remote store to realise the
		// installable.
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

export type ParsedPlannedLocalOutput = z.output<
	typeof plannedLocalOutputSchema
>;

export const cohortPlanInputSchema = z
	.strictObject({
		targets: z.array(cohortTargetSchema).min(1),
		// Paths available for the final, target-specific copy after availability is
		// rechecked.
		plannedLocalClosure: z.array(storePathSchema).optional(),
		// A remote query can stop at a derivation that has not been copied. These
		// derivations let the planner check their known outputs instead.
		plannedSubstitutableDerivations: z.array(storePathSchema).optional(),
		// These output selections need the derivation's realisation mapping; a
		// narinfo alone cannot supply it to the selected store.
		plannedFloatingOutputs: z.array(plannedFloatingOutputSchema).optional(),
		// Pair each known output path with the derivation output that produces it.
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

// Measurement asks the selected store for every missing substitutable path
// needed to realise the installable. It does not need destination or retention
// metadata.
export const measureTargetSchema = z.strictObject({
	attr: attributeSchema,
	installable: cohortInstallableSchema
});
export type ParsedMeasureTarget = z.output<typeof measureTargetSchema>;

export const measurePlanInputSchema = z.strictObject({
	targets: z.array(measureTargetSchema).min(1)
});
