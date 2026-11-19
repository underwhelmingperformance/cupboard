import { describe, expect, it } from 'vitest';

import { readFoundInGroups } from './found-reads.ts';

const keys = [
	'missing-1',
	'found-1',
	'found-2',
	'missing-2',
	'missing-3',
	'found-3',
	'found-4',
	'found-5',
	'found-6',
	'missing-4',
	'found-7',
	'found-8',
	'missing-5',
	'missing-6'
];

const firstGroup = [
	'found-1',
	'found-2',
	'found-3',
	'found-4',
	'found-5',
	'found-6'
];

const firstGroupEntries = [
	'missing-1: missing',
	'found-1: read with version 1',
	'found-2: read with version 2',
	'missing-2: missing',
	'missing-3: missing',
	'found-3: read with version 3',
	'found-4: read with version 4',
	'found-5: read with version 5',
	'found-6: read with version 6'
];

async function readKeys(
	stopAfter: number | undefined
): Promise<{ entries: string[]; groups: string[][]; reads: string[] }> {
	const groups: string[][] = [];
	const reads: string[] = [];
	const entries: string[] = [];
	const source = readFoundInGroups(keys, {
		version: (key) =>
			key.startsWith('found-') ? Number(key.slice('found-'.length)) : undefined,
		missing: (key) => `${key}: missing`,
		read: (key, version) => {
			reads.push(key);
			return Promise.resolve(`${key}: read with version ${String(version)}`);
		},
		beforeGroup: (group) => {
			groups.push([...group]);
		},
		refusal: (failure) => failure
	});

	for await (const entry of source) {
		entries.push(entry);
		if (entries.length === stopAfter) {
			break;
		}
	}

	return { entries, groups, reads };
}

describe('readFoundInGroups', () => {
	it.each([
		{
			name: 'reads the found keys in groups and yields every key in order',
			stopAfter: undefined,
			expected: {
				entries: [
					...firstGroupEntries,
					'missing-4: missing',
					'found-7: read with version 7',
					'found-8: read with version 8',
					'missing-5: missing',
					'missing-6: missing'
				],
				groups: [firstGroup, ['found-7', 'found-8']],
				reads: [...firstGroup, 'found-7', 'found-8']
			}
		},
		{
			name: 'does not read the next group when the caller stops after a group',
			stopAfter: firstGroupEntries.length,
			expected: {
				entries: firstGroupEntries,
				groups: [firstGroup],
				reads: firstGroup
			}
		}
	])('$name', async ({ stopAfter, expected }) => {
		expect(await readKeys(stopAfter)).toStrictEqual(expected);
	});
});
