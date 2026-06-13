import { bench, describe } from 'vitest';

import { BinaryFuse8 } from './filter.ts';

interface FilterCandidate {
	has(value: string): boolean;
}

const benchSink: { value: unknown } = { value: undefined };

function sink(value: unknown): void {
	benchSink.value = value;
}

function slugs(count: number, prefix = 'tenant'): string[] {
	return Array.from(
		{ length: count },
		(_, index) => `${prefix}-${String(index)}`
	);
}

function probes(values: readonly string[], count: number): string[] {
	return Array.from(
		{ length: count },
		(_, index) => values[index % values.length] ?? ''
	);
}

function assertNoFalseNegatives(
	name: string,
	filter: FilterCandidate,
	members: readonly string[]
): void {
	const missing = members.filter((value) => !filter.has(value));

	if (missing.length > 0) {
		throw new Error(`${name} had ${String(missing.length)} false negative(s)`);
	}
}

function countMatches(
	filter: FilterCandidate,
	values: readonly string[]
): number {
	let matches = 0;

	for (const value of values) {
		if (filter.has(value)) {
			matches += 1;
		}
	}

	return matches;
}

const smallMembers = slugs(1000);
const largeMembers = slugs(10_000);
const unicodeMembers = [
	...slugs(1000),
	'tenant-é',
	'tenant-e\u0301',
	'tenant-雪',
	'tenant-💾',
	'tenant-مرحبا'
];
const presentBatch = probes(largeMembers, 1024);
const absentBatch = probes(slugs(1024, 'absent'), 1024);
const mixedBatch = Array.from({ length: 1024 }, (_, index) =>
	index % 2 === 0
		? (largeMembers[index % largeMembers.length] ?? '')
		: `absent-${String(index)}`
);
const unicodeBatch = probes(unicodeMembers, 1024);

const largeFilter = BinaryFuse8.build(largeMembers);
const unicodeFilter = BinaryFuse8.build(unicodeMembers);
const serialisedLargeFilter = largeFilter.serialise();

assertNoFalseNegatives('large filter', largeFilter, largeMembers);
assertNoFalseNegatives('Unicode filter', unicodeFilter, unicodeMembers);

describe('BinaryFuse8 build', () => {
	bench('build 1,000 strings', () => {
		sink(BinaryFuse8.build(smallMembers));
	});

	bench('build 10,000 strings', () => {
		sink(BinaryFuse8.build(largeMembers));
	});
});

describe('BinaryFuse8 deserialise', () => {
	bench('deserialise 10,000-string filter', () => {
		sink(BinaryFuse8.deserialise(serialisedLargeFilter));
	});
});

describe('BinaryFuse8 has batches', () => {
	bench('has 1,024 present strings', () => {
		sink(countMatches(largeFilter, presentBatch));
	});

	bench('has 1,024 absent strings', () => {
		sink(countMatches(largeFilter, absentBatch));
	});

	bench('has 1,024 mixed strings', () => {
		sink(countMatches(largeFilter, mixedBatch));
	});

	bench('has 1,024 Unicode strings', () => {
		sink(countMatches(unicodeFilter, unicodeBatch));
	});
});
