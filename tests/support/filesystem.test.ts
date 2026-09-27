import { afterEach, describe, expect, it, vi } from 'vitest';

import { withTemporaryDirectory } from './filesystem.ts';

// When a test sets `failure`, every removal deletes its target and then
// rejects with that error.
const removal = vi.hoisted((): { failure?: Error } => ({}));

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();

	return {
		...actual,
		rm: async (...arguments_: Parameters<typeof actual.rm>) => {
			await actual.rm(...arguments_);

			if (removal.failure !== undefined) {
				throw removal.failure;
			}
		}
	};
});

describe('withTemporaryDirectory', () => {
	afterEach(() => {
		delete removal.failure;
	});

	it('reports the failure of its body when removing the directory also fails', async () => {
		const bodyFailure = new Error('the assertion failed');
		removal.failure = new Error('the directory could not be removed');

		await expect(
			withTemporaryDirectory('cupboard-cleanup-', () =>
				Promise.reject(bodyFailure)
			)
		).rejects.toBe(bodyFailure);
	});
});
