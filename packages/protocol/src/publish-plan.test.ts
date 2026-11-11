import { describe, expect, it } from 'vitest';

import {
	isNixPositionalArgument,
	publishPlanDocumentSchema
} from './publish-plan.ts';

const target = {
	attr: '.#packages.x86_64-linux.app',
	system: 'x86_64-linux',
	os: 'ubuntu-latest',
	remote: false,
	bestEffort: false,
	rootSuffix: 'x86_64-linux/app',
	outputs: ['out']
};

const document = {
	version: 1,
	retained: [],
	targets: [target],
	cohorts: [
		{
			key: 'cohort-x86_64-linux-ubuntu-latest-local-0123456789abcdef',
			system: 'x86_64-linux',
			os: 'ubuntu-latest',
			remote: false,
			targets: [target],
			installables: ['.#packages.x86_64-linux.app^out']
		}
	],
	derivationToTargets: [
		{
			drvPath: `/nix/store/${'0'.repeat(32)}-app.drv`,
			targets: ['.#packages.x86_64-linux.app']
		}
	],
	cohortPreFilter: [
		{
			key: 'cohort-x86_64-linux-ubuntu-latest-local-0123456789abcdef',
			pruned: false
		}
	],
	referencePublications: [
		{
			attr: '.#packages.x86_64-linux.app',
			root: 'github:owner/repo/main/x86_64-linux/app',
			source: 'https://cupboard.example.workers.dev/t/acme',
			paths: [`/nix/store/${'1'.repeat(32)}-app`],
			status: 'published'
		}
	]
};

describe('isNixPositionalArgument', () => {
	it.each([
		['a flake attribute', '.#packages.x86_64-linux.app', true],
		['an option-like value', '--refresh', false],
		['a line break', '.#app\n--refresh', false],
		['an embedded tab', '.#app\tdev', false],
		['a delete character', '.#app\u{7F}', false],
		['a C1 control character', '.#app\u{85}', false]
	])('%s', (_name, value, expected) => {
		expect(isNixPositionalArgument(value)).toBe(expected);
	});
});

describe('publishPlanDocumentSchema', () => {
	it('reads a document of the current version unchanged', () => {
		expect(publishPlanDocumentSchema.parse(document)).toStrictEqual(document);
	});

	it.each([
		{ name: 'an older version', value: { ...document, version: 0 } },
		{ name: 'a newer version', value: { ...document, version: 2 } },
		{
			name: 'no version',
			value: Object.fromEntries(
				Object.entries(document).filter(([key]) => key !== 'version')
			)
		}
	])('refuses a document with $name', ({ value }) => {
		const parsed = publishPlanDocumentSchema.safeParse(value);

		expect(parsed.error?.issues.map((issue) => issue.path)).toStrictEqual([
			['version']
		]);
	});
});
