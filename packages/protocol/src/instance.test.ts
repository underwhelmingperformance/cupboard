import { describe, expect, it } from 'vitest';

import { instanceNameSchema } from './instance.ts';

describe('instanceNameSchema', () => {
	it.each(['cupboard', 'office-cache', 'c1'])('accepts %s', (value) => {
		expect(instanceNameSchema.parse(value)).toBe(value);
	});

	it.each(['Cupboard', '-cupboard', 'cupboard-', 'cupboard_name', ''])(
		'rejects %s',
		(value) => {
			expect(instanceNameSchema.safeParse(value).success).toBe(false);
		}
	);
});
