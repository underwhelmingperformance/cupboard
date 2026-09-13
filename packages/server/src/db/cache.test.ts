import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cacheScopeFromRow } from './cache.ts';

describe('cache identity', () => {
	it.each([
		{
			name: 'a default row',
			row: { kind: 'default' },
			scope: { kind: 'default' }
		},
		{
			name: 'a named row',
			row: { kind: 'named', name: 'builds' },
			scope: { kind: 'named', name: 'builds' }
		}
	] as const)('reads the scope of $name', ({ row, scope }) => {
		expect(cacheScopeFromRow(row)).toStrictEqual(scope);
	});

	it.each([
		{ name: 'a default row with a name', row: { kind: 'default', name: 'x' } },
		{ name: 'a named row without a name', row: { kind: 'named' } }
	] as const)('refuses $name', ({ row }) => {
		expect(() => cacheScopeFromRow(row)).toThrow(z.ZodError);
	});
});
