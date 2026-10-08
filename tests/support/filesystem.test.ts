import { watch } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForFile, withTemporaryDirectory } from './filesystem.ts';

// When a test sets `failure`, every removal deletes its target and then
// rejects with that error.
const removal = vi.hoisted((): { failure?: Error } => ({}));

const inspection = vi.hoisted((): { onStat?: () => void } => ({}));

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();

	return { ...actual, watch: vi.fn(actual.watch) };
});

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();

	return {
		...actual,
		rm: async (...arguments_: Parameters<typeof actual.rm>) => {
			await actual.rm(...arguments_);

			if (removal.failure !== undefined) {
				throw removal.failure;
			}
		},
		stat: (...arguments_: Parameters<typeof actual.stat>) => {
			inspection.onStat?.();
			return actual.stat(...arguments_);
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

describe('waitForFile', () => {
	afterEach(() => {
		delete inspection.onStat;
		vi.mocked(watch).mockClear();
	});

	it('does not watch the directory when cancelled during the initial stat', async () => {
		await withTemporaryDirectory(
			'cupboard-cancelled-wait-',
			async (directory) => {
				const controller = new AbortController();
				const cancellation = new Error('cancelled wait');
				inspection.onStat = () => {
					controller.abort(cancellation);
				};

				let outcome: unknown = 'resolved';

				try {
					await waitForFile(path.join(directory, 'missing'), controller.signal);
				} catch (error) {
					outcome = error;
				}

				expect({
					outcome,
					watchCalls: vi.mocked(watch).mock.calls.length
				}).toStrictEqual({ outcome: cancellation, watchCalls: 0 });
			}
		);
	});
});
