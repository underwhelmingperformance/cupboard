import { describe, expect, it } from 'vitest';

import {
	declaredGroups,
	DuplicateTargetAttributeError,
	ManifestJsonError,
	ManifestSchemaError,
	parseManifest
} from './manifest.ts';

const app = {
	attr: 'app',
	system: 'x86_64-linux',
	os: 'ubuntu-latest',
	remote: false,
	rootSuffix: 'app'
};
const tool = {
	attr: 'tool',
	system: 'x86_64-linux',
	os: 'ubuntu-latest',
	remote: false,
	rootSuffix: 'tool'
};
const parsedApp = {
	attr: 'app',
	system: 'x86_64-linux',
	os: 'ubuntu-latest',
	remote: false,
	bestEffort: false,
	rootSuffix: 'app',
	outputs: ['out']
};
const parsedTool = { ...parsedApp, attr: 'tool', rootSuffix: 'tool' };

describe('parseManifest', () => {
	it.each([
		{ name: 'a bare targets array', source: JSON.stringify([app, tool]) },
		{
			name: 'the targets array under a targets key',
			source: JSON.stringify({ targets: [app, tool] })
		}
	])('reads $name', ({ source }) => {
		expect(parseManifest(source)).toStrictEqual([parsedApp, parsedTool]);
	});

	it('publishes a component target as its components', () => {
		const source = JSON.stringify([
			{
				...app,
				attr: 'bundle',
				rootSuffix: 'bundle',
				cohort: 'linux',
				components: [{ attr: 'first' }, { attr: 'second', outputs: ['lib'] }]
			}
		]);

		expect(parseManifest(source)).toStrictEqual([
			{
				attr: 'first',
				system: 'x86_64-linux',
				os: 'ubuntu-latest',
				remote: false,
				bestEffort: false,
				rootSuffix: 'bundle',
				outputs: ['out'],
				cohort: 'linux'
			},
			{
				attr: 'second',
				system: 'x86_64-linux',
				os: 'ubuntu-latest',
				remote: false,
				bestEffort: false,
				rootSuffix: 'bundle',
				outputs: ['lib'],
				cohort: 'linux'
			}
		]);
	});

	it.each([
		{
			name: 'a source that is not JSON',
			source: 'not json',
			expected: ManifestJsonError
		},
		{
			name: 'a target missing its execution context',
			source: JSON.stringify([{ attr: 'app', rootSuffix: 'app' }]),
			expected: ManifestSchemaError
		},
		{
			name: 'an empty manifest',
			source: JSON.stringify([]),
			expected: ManifestSchemaError
		},
		{
			name: 'two targets sharing one attr',
			source: JSON.stringify([app, { ...app, rootSuffix: 'other' }]),
			expected: DuplicateTargetAttributeError
		}
	])('refuses $name', ({ source, expected }) => {
		expect(() => parseManifest(source)).toThrow(expected);
	});
});

describe('declaredGroups', () => {
	it.each([
		{
			name: 'no labels at all',
			targets: [parsedApp, parsedTool],
			expected: []
		},
		{
			name: 'a label held by one target',
			targets: [{ ...parsedApp, cohort: 'linux' }, parsedTool],
			expected: []
		},
		{
			name: 'a label shared by two targets',
			targets: [
				{ ...parsedApp, cohort: 'linux' },
				{ ...parsedTool, cohort: 'linux' }
			],
			expected: [{ key: 'linux', attrs: ['app', 'tool'] }]
		},
		{
			name: 'two shared labels, reported in key order',
			targets: [
				{ ...parsedApp, cohort: 'second' },
				{ ...parsedTool, cohort: 'first' },
				{ ...parsedApp, attr: 'other', rootSuffix: 'other', cohort: 'second' },
				{ ...parsedTool, attr: 'more', rootSuffix: 'more', cohort: 'first' }
			],
			expected: [
				{ key: 'first', attrs: ['tool', 'more'] },
				{ key: 'second', attrs: ['app', 'other'] }
			]
		}
	])('groups $name', ({ targets, expected }) => {
		expect(declaredGroups(targets)).toStrictEqual(expected);
	});
});
