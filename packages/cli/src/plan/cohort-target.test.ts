import { describe, expect, it } from 'vitest';

import {
	cohortInstallableSchema,
	cohortPlanInputSchema,
	cohortTargetSchema
} from './cohort-target.ts';

const storePath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const derivation = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv';

describe('cohortInstallableSchema', () => {
	it('accepts a plain store path unchanged', () => {
		expect(cohortInstallableSchema.parse(storePath)).toBe(storePath);
	});

	it('accepts a derivation path with an output selector', () => {
		const installable = `${derivation}^out`;

		expect(cohortInstallableSchema.parse(installable)).toBe(installable);
	});

	it.each([
		{ name: 'not a store path at all', value: 'not-a-store-path' },
		{
			name: 'a caret with no store path in front of it',
			value: 'not-a-store-path^out'
		},
		{ name: 'the empty string', value: '' },
		{ name: 'an empty output selection', value: `${derivation}^` },
		{
			name: 'an output selection carrying a control character',
			value: `${derivation}^out\n::error::forged`
		}
	])('rejects $name', ({ value }) => {
		expect(cohortInstallableSchema.safeParse(value).success).toBe(false);
	});
});

describe('cohortTargetSchema', () => {
	const validTarget = {
		attr: 'packages.x86_64-linux.app',
		installable: `${derivation}^out`,
		expectedPath: storePath,
		plannedLocalDerivation: derivation,
		root: 'github:owner/repo/main'
	};

	it('parses a fully specified target', () => {
		expect(cohortTargetSchema.parse(validTarget)).toStrictEqual(validTarget);
	});

	it('parses a target with no expected output path', () => {
		const { expectedPath: _expectedPath, ...withoutExpectedPath } = validTarget;

		expect(cohortTargetSchema.parse(withoutExpectedPath)).toStrictEqual(
			withoutExpectedPath
		);
	});

	it.each([
		{
			name: 'a different derivation',
			plannedLocalDerivation:
				'/nix/store/1123456789abcdfghijklmnpqrsvwxyz-other.drv'
		},
		{ name: 'a non-derivation store path', plannedLocalDerivation: storePath }
	])('rejects $name as local copy evidence', ({ plannedLocalDerivation }) => {
		expect(
			cohortTargetSchema.safeParse({
				...validTarget,
				plannedLocalDerivation
			}).success
		).toBe(false);
	});

	it('rejects an unknown field', () => {
		expect(
			cohortTargetSchema.safeParse({ ...validTarget, extra: 'nope' }).success
		).toBe(false);
	});

	it('rejects an attr carrying a control character', () => {
		expect(
			cohortTargetSchema.safeParse({
				...validTarget,
				attr: 'app\n::error::forged'
			}).success
		).toBe(false);
	});
});

describe('cohortPlanInputSchema', () => {
	it('rejects an empty targets array', () => {
		expect(cohortPlanInputSchema.safeParse({ targets: [] }).success).toBe(
			false
		);
	});

	it('parses one or more targets', () => {
		const target = {
			attr: 'packages.x86_64-linux.app',
			installable: storePath,
			root: 'github:owner/repo/main'
		};

		expect(cohortPlanInputSchema.parse({ targets: [target] })).toStrictEqual({
			targets: [target]
		});
	});

	it('parses the paths in a planned local closure', () => {
		const target = {
			attr: 'packages.x86_64-linux.app',
			installable: storePath,
			root: 'github:owner/repo/main'
		};
		const source =
			'/nix/store/22222222222222222222222222222222-source' as const;

		expect(
			cohortPlanInputSchema.parse({
				targets: [target],
				plannedLocalClosure: [source]
			})
		).toStrictEqual({ targets: [target], plannedLocalClosure: [source] });
	});

	it('parses substitution policy for a copied derivation', () => {
		const target = {
			attr: 'packages.x86_64-linux.app',
			installable: storePath,
			root: 'github:owner/repo/main'
		};
		const input = {
			targets: [target],
			plannedLocalClosure: [derivation],
			plannedSubstitutableDerivations: [derivation]
		};

		expect(cohortPlanInputSchema.parse(input)).toStrictEqual(input);
	});

	it.each([
		{
			name: 'is not a derivation',
			plannedLocalClosure: [storePath],
			plannedSubstitutableDerivations: [storePath]
		},
		{
			name: 'is absent from the copied closure',
			plannedLocalClosure: [] as const,
			plannedSubstitutableDerivations: [derivation]
		}
	])(
		'rejects substitution policy when a path $name',
		({ plannedLocalClosure, plannedSubstitutableDerivations }) => {
			const parsed = cohortPlanInputSchema.safeParse({
				targets: [
					{
						attr: 'packages.x86_64-linux.app',
						installable: storePath,
						root: 'github:owner/repo/main'
					}
				],
				plannedLocalClosure,
				plannedSubstitutableDerivations
			});

			expect({
				success: parsed.success,
				issues: parsed.success
					? []
					: parsed.error.issues.map(({ code, path }) => ({ code, path }))
			}).toStrictEqual({
				success: false,
				issues: [
					{
						code: 'custom',
						path: ['plannedSubstitutableDerivations', 0]
					}
				]
			});
		}
	);

	it('parses an output that the action can realise from a copied derivation', () => {
		const target = {
			attr: 'packages.x86_64-linux.app',
			installable: storePath,
			root: 'github:owner/repo/main'
		};
		const output =
			'/nix/store/22222222222222222222222222222222-dependency' as const;
		const installable = `${derivation}^out` as const;

		expect(
			cohortPlanInputSchema.parse({
				targets: [target],
				plannedLocalClosure: [derivation],
				plannedLocalOutputs: [{ path: output, installable }]
			})
		).toStrictEqual({
			targets: [target],
			plannedLocalClosure: [derivation],
			plannedLocalOutputs: [{ path: output, installable }]
		});
	});

	it('parses a floating output from a derivation in the copied closure', () => {
		const target = {
			attr: 'packages.x86_64-linux.app',
			installable: storePath,
			root: 'github:owner/repo/main'
		};
		const installable = `${derivation}^out` as const;

		expect(
			cohortPlanInputSchema.parse({
				targets: [target],
				plannedLocalClosure: [derivation],
				plannedFloatingOutputs: [installable]
			})
		).toStrictEqual({
			targets: [target],
			plannedLocalClosure: [derivation],
			plannedFloatingOutputs: [installable]
		});
	});

	it('rejects a floating output whose derivation is not copied', () => {
		const parsed = cohortPlanInputSchema.safeParse({
			targets: [
				{
					attr: 'packages.x86_64-linux.app',
					installable: storePath,
					root: 'github:owner/repo/main'
				}
			],
			plannedLocalClosure: [],
			plannedFloatingOutputs: [`${derivation}^out`]
		});

		expect({
			success: parsed.success,
			issues: parsed.success
				? []
				: parsed.error.issues.map(({ code, path }) => ({ code, path }))
		}).toStrictEqual({
			success: false,
			issues: [{ code: 'custom', path: ['plannedFloatingOutputs', 0] }]
		});
	});

	it.each([
		{
			name: 'its derivation is absent from the copied closure',
			plannedLocalClosure: [] as const,
			installable: `${derivation}^out` as const
		},
		{
			name: 'its installable does not refer to a derivation',
			plannedLocalClosure: undefined,
			installable: `${storePath}^out` as const
		},
		{
			name: 'its installable selects every output',
			plannedLocalClosure: [derivation] as const,
			installable: `${derivation}^*` as const
		},
		{
			name: 'its installable selects several outputs',
			plannedLocalClosure: [derivation] as const,
			installable: `${derivation}^out,dev` as const
		},
		{
			name: 'its installable contains another selector',
			plannedLocalClosure: [derivation] as const,
			installable: `${derivation}^out^dev` as const
		}
	])('rejects an output when $name', ({ plannedLocalClosure, installable }) => {
		const parsed = cohortPlanInputSchema.safeParse({
			targets: [
				{
					attr: 'packages.x86_64-linux.app',
					installable: storePath,
					root: 'github:owner/repo/main'
				}
			],
			...(plannedLocalClosure !== undefined && { plannedLocalClosure }),
			plannedLocalOutputs: [{ path: storePath, installable }]
		});
		const issues = parsed.success
			? []
			: parsed.error.issues.map(({ code, path }) => ({ code, path }));

		expect({ success: parsed.success, issues }).toStrictEqual({
			success: false,
			issues: [
				{
					code: 'custom',
					path: ['plannedLocalOutputs', 0, 'installable']
				}
			]
		});
	});
});
