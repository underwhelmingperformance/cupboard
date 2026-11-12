import { storePathSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	cohortRootsDocumentSchema,
	isNixPositionalArgument,
	joinRoot,
	publishPlanDocumentSchema,
	retainedRoots
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

const appPath = storePathSchema.parse(`/nix/store/${'1'.repeat(32)}-app`);
const developmentPath = storePathSchema.parse(
	`/nix/store/${'2'.repeat(32)}-app-dev`
);
const libraryPath = storePathSchema.parse(
	`/nix/store/${'3'.repeat(32)}-library`
);

const document = {
	version: 2,
	rootPrefix: 'github:owner/repo/main',
	retained: [
		{
			...target,
			attr: '.#library',
			rootSuffix: 'library',
			paths: [libraryPath]
		}
	],
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
		{ name: 'the previous version', value: { ...document, version: 1 } },
		{ name: 'a newer version', value: { ...document, version: 3 } },
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

describe('joinRoot', () => {
	it.each([
		{ prefix: 'github:owner/repo/main', suffix: 'app' },
		{ prefix: 'github:owner/repo/main', suffix: '/app' },
		{ prefix: 'github:owner/repo/main', suffix: 'app/' },
		{ prefix: 'github:owner/repo/main/', suffix: 'app' }
	])('joins $prefix and $suffix to one root', ({ prefix, suffix }) => {
		expect(joinRoot(prefix, suffix)).toBe('github:owner/repo/main/app');
	});
});

describe('retainedRoots', () => {
	it('merges the retained targets that share a root, in plan order', () => {
		const roots = retainedRoots({
			rootPrefix: 'github:owner/repo/main/',
			retained: [
				{ ...target, rootSuffix: 'app', paths: [appPath] },
				{ ...target, rootSuffix: 'library', paths: [libraryPath] },
				{
					...target,
					attr: '.#app-dev',
					rootSuffix: 'app',
					outputs: ['dev', 'out'],
					paths: [developmentPath, appPath]
				}
			]
		});

		expect(roots).toStrictEqual([
			{
				name: 'github:owner/repo/main/app',
				targets: [appPath, developmentPath]
			},
			{ name: 'github:owner/repo/main/library', targets: [libraryPath] }
		]);
	});

	it('refuses a document whose retained target has no valid root name', () => {
		const parsed = publishPlanDocumentSchema.safeParse({
			...document,
			rootPrefix: 'x'.repeat(1024)
		});

		expect(parsed.error?.issues.map((issue) => issue.path)).toStrictEqual([
			['retained', 0, 'rootSuffix']
		]);
	});
});

describe('cohortRootsDocumentSchema', () => {
	const roots = {
		version: 1,
		roots: [
			{ action: 'set', name: 'github:owner/repo/main/app', targets: [appPath] },
			{ action: 'set', name: 'github:owner/repo/main/upstream', targets: [] },
			{ action: 'unchanged', name: 'github:owner/repo/main/failed' }
		]
	};

	it('reads a document of the current version unchanged', () => {
		expect(cohortRootsDocumentSchema.parse(roots)).toStrictEqual(roots);
	});

	it.each([
		{
			name: 'another version',
			value: { ...roots, version: 2 },
			path: ['version']
		},
		{ name: 'no roots', value: { ...roots, roots: [] }, path: ['roots'] },
		{
			name: 'a root listed twice',
			value: {
				...roots,
				roots: [
					...roots.roots,
					{ action: 'unchanged', name: 'github:owner/repo/main/app' }
				]
			},
			path: ['roots', 3, 'name']
		}
	])('refuses a document with $name', ({ value, path }) => {
		const parsed = cohortRootsDocumentSchema.safeParse(value);

		expect(parsed.error?.issues.map((issue) => issue.path)).toStrictEqual([
			path
		]);
	});
});
