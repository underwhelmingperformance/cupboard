import { describe, expect, it } from 'vitest';

import {
	type RootEnsureBodyInput,
	rootEnsureBodySchema,
	rootEnsureResponseSchema,
	rootListResponseSchema,
	rootSetBodySchema,
	rootSetMaxTargets,
	rootTargetsPageSchema
} from './retention.ts';

const storePathHash = '0'.repeat(32);
const storePath = `/nix/store/${storePathHash}-name`;

describe('rootSetBodySchema', () => {
	it.each([
		{
			name: 'a target list which inherits retention',
			value: { targets: [storePath] },
			expected: { targets: [storePath], retention: { kind: 'inherit' } }
		},
		{
			name: 'a target list with a duration',
			value: {
				targets: [storePath],
				retention: { kind: 'duration', seconds: 3600 }
			},
			expected: {
				targets: [storePath],
				retention: { kind: 'duration', seconds: 3600 }
			}
		},
		{
			name: 'a permanently retained target list',
			value: { targets: [storePath], retention: { kind: 'permanent' } },
			expected: { targets: [storePath], retention: { kind: 'permanent' } }
		},
		{
			name: 'an empty target list',
			value: { targets: [] },
			expected: { targets: [], retention: { kind: 'inherit' } }
		}
	])('accepts $name', ({ value, expected }) => {
		expect(rootSetBodySchema.parse(value)).toStrictEqual(expected);
	});

	it('accepts a target list at the bound', () => {
		const targets = Array.from(
			{ length: rootSetMaxTargets },
			(_, index) =>
				`/nix/store/${String(index).padStart(32, '0')}-name-${String(index)}`
		);

		expect(rootSetBodySchema.parse({ targets })).toStrictEqual({
			targets,
			retention: { kind: 'inherit' }
		});
	});

	it('rejects a target list over the bound', () => {
		const targets = Array.from(
			{ length: rootSetMaxTargets + 1 },
			(_, index) =>
				`/nix/store/${String(index).padStart(32, '0')}-name-${String(index)}`
		);

		expect(rootSetBodySchema.safeParse({ targets }).success).toBe(false);
	});

	it.each([
		{
			name: 'a nested target path',
			value: { targets: [`${storePath}/x`] }
		},
		{
			name: 'an out-of-range ttl',
			value: {
				targets: [storePath],
				retention: { kind: 'duration', seconds: 0 }
			}
		}
	])('rejects $name', ({ value }) => {
		expect(rootSetBodySchema.safeParse(value).success).toBe(false);
	});
});

describe('rootEnsureBodySchema', () => {
	it('accepts a non-empty target list', () => {
		const value: RootEnsureBodyInput = {
			targets: [storePath],
			retention: { kind: 'duration', seconds: 3600 }
		};

		expect(rootEnsureBodySchema.parse(value)).toStrictEqual(value);
	});

	it('rejects an empty target list', () => {
		expect(rootEnsureBodySchema.safeParse({ targets: [] }).success).toBe(false);
	});
});

describe('rootEnsureResponseSchema', () => {
	it.each([
		{
			name: 'a retained root',
			value: {
				status: 'retained',
				root: {
					name: 'main',
					expired: false,
					createdAt: '2026-07-10T00:00:00.000Z',
					updatedAt: '2026-07-10T00:00:00.000Z',
					targets: [
						{
							storePathHash,
							storePath,
							present: true
						}
					]
				}
			}
		},
		{
			name: 'a build requirement',
			value: { status: 'build-required', unavailable: [storePath] }
		}
	])('accepts $name', ({ value }) => {
		expect(rootEnsureResponseSchema.parse(value)).toStrictEqual(value);
	});
});

describe('rootListResponseSchema', () => {
	const listedRoot = {
		name: 'github:owner/repo/main',
		expired: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		targetCount: 3
	};

	it.each([
		{ name: 'a final page', value: { roots: [listedRoot] } },
		{
			name: 'a page with a continuation',
			value: { roots: [listedRoot], cursor: listedRoot.name }
		},
		{ name: 'an empty listing', value: { roots: [] } }
	])('accepts $name', ({ value }) => {
		expect(rootListResponseSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'an entry with inline targets',
			value: { roots: [{ ...listedRoot, targets: [] }] }
		},
		{
			name: 'a negative target count',
			value: { roots: [{ ...listedRoot, targetCount: -1 }] }
		},
		{ name: 'an empty cursor', value: { roots: [], cursor: '' } }
	])('rejects $name', ({ value }) => {
		expect(rootListResponseSchema.safeParse(value).success).toBe(false);
	});
});

describe('rootTargetsPageSchema', () => {
	const pageTarget = {
		storePathHash: '0'.repeat(32),
		storePath: `/nix/store/${'0'.repeat(32)}-name`,
		present: true
	};

	it.each([
		{ name: 'a final page', value: { targets: [pageTarget] } },
		{
			name: 'a page with a continuation',
			value: { targets: [pageTarget], cursor: pageTarget.storePathHash }
		},
		{ name: 'an empty page', value: { targets: [] } }
	])('accepts $name', ({ value }) => {
		expect(rootTargetsPageSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'a target with no present flag',
			value: {
				targets: [
					{
						storePathHash: pageTarget.storePathHash,
						storePath: pageTarget.storePath
					}
				]
			}
		},
		{ name: 'an empty cursor', value: { targets: [], cursor: '' } }
	])('rejects $name', ({ value }) => {
		expect(rootTargetsPageSchema.safeParse(value).success).toBe(false);
	});
});
