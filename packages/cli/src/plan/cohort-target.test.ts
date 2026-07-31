import { describe, expect, it } from 'vitest';

import {
	cohortInstallableSchema,
	cohortPlanInputSchema,
	cohortTargetSchema
} from './cohort-target.ts';

const storePath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';

describe('cohortInstallableSchema', () => {
	it('accepts a plain store path unchanged', () => {
		expect(cohortInstallableSchema.parse(storePath)).toBe(storePath);
	});

	it('accepts a derivation path with an output selector', () => {
		const derivation = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv';
		const installable = `${derivation}^out`;

		expect(cohortInstallableSchema.parse(installable)).toBe(installable);
	});

	it.each([
		{ name: 'not a store path at all', value: 'not-a-store-path' },
		{
			name: 'a caret with no store path in front of it',
			value: 'not-a-store-path^out'
		},
		{ name: 'the empty string', value: '' }
	])('rejects $name', ({ value }) => {
		expect(cohortInstallableSchema.safeParse(value).success).toBe(false);
	});
});

describe('cohortTargetSchema', () => {
	const validTarget = {
		attr: 'packages.x86_64-linux.app',
		installable: storePath,
		expectedPath: storePath,
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

	it('rejects an unknown field', () => {
		expect(
			cohortTargetSchema.safeParse({ ...validTarget, extra: 'nope' }).success
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
});
