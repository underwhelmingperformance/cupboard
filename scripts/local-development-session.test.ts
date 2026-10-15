import { withCleanup } from '@cupboard/shared/cleanup';
import { describe, expect, it, vi } from 'vitest';

import {
	type LocalDevelopmentPlatform,
	type LocalDevelopmentPlatformFactory,
	LocalDevelopmentSession
} from '../packages/server/scripts/local-development-session.ts';

import { LocalWranglerDatabase } from './local-development-bootstrap.ts';

function fixture() {
	const query = vi.fn<LocalDevelopmentPlatform['query']>((binding, statement) =>
		Promise.resolve([{ binding, statement }])
	);
	const execute = vi
		.fn<LocalDevelopmentPlatform['execute']>()
		.mockResolvedValue(undefined);
	const dispose = vi
		.fn<LocalDevelopmentPlatform['dispose']>()
		.mockResolvedValue(undefined);
	const platform: LocalDevelopmentPlatform = { query, execute, dispose };
	const create = vi
		.fn<LocalDevelopmentPlatformFactory>()
		.mockResolvedValue(platform);
	const session = new LocalDevelopmentSession(
		'/config/wrangler.jsonc',
		'/local/state',
		create
	);
	return { session, create, query, execute, dispose };
}

describe('local development binding sessions', () => {
	it('reuses one platform across bindings and concurrent queries until disposal', async () => {
		const { session, create, query, execute, dispose } = fixture();
		const shared = new LocalWranglerDatabase(
			'/local/state',
			'CUPBOARD_DB',
			session
		);
		const control = new LocalWranglerDatabase(
			'/local/state',
			'CONTROL_DB',
			session
		);
		const results = await Promise.all([
			shared.query('SELECT shared'),
			control.query('SELECT control')
		]);
		await shared.execute('UPDATE shared');
		await session.dispose();
		await session.dispose();
		expect({
			results,
			opens: create.mock.calls,
			queries: query.mock.calls,
			writes: execute.mock.calls,
			disposals: dispose.mock.calls
		}).toStrictEqual({
			results: [
				[{ binding: 'CUPBOARD_DB', statement: 'SELECT shared' }],
				[{ binding: 'CONTROL_DB', statement: 'SELECT control' }]
			],
			opens: [['/config/wrangler.jsonc', '/local/state']],
			queries: [
				['CUPBOARD_DB', 'SELECT shared'],
				['CONTROL_DB', 'SELECT control']
			],
			writes: [['CUPBOARD_DB', 'UPDATE shared']],
			disposals: [[]]
		});
	});

	it('opens a replacement after disposal for queries after an external migration', async () => {
		const { session, create, dispose } = fixture();
		await session.query('CUPBOARD_DB', 'SELECT before');
		await session.dispose();
		await session.query('CUPBOARD_DB', 'SELECT after');
		await session.dispose();
		expect({
			opens: create.mock.calls,
			disposals: dispose.mock.calls
		}).toStrictEqual({
			opens: [
				['/config/wrangler.jsonc', '/local/state'],
				['/config/wrangler.jsonc', '/local/state']
			],
			disposals: [[], []]
		});
	});

	it('can retry platform creation after a failed start without disposing an unavailable platform', async () => {
		const { session, create, dispose } = fixture();
		const failure = new Error('Local platform did not start');
		create.mockRejectedValueOnce(failure);
		await expect(session.query('CUPBOARD_DB', 'SELECT failed')).rejects.toBe(
			failure
		);
		await session.dispose();
		const result = await session.query('CUPBOARD_DB', 'SELECT retried');
		await session.dispose();
		expect({
			result,
			opens: create.mock.calls,
			disposals: dispose.mock.calls
		}).toStrictEqual({
			result: [{ binding: 'CUPBOARD_DB', statement: 'SELECT retried' }],
			opens: [
				['/config/wrangler.jsonc', '/local/state'],
				['/config/wrangler.jsonc', '/local/state']
			],
			disposals: [[]]
		});
	});

	it.each(['query', 'execute'] as const)(
		'disposes the platform when %s fails in its scope',
		async (operation) => {
			const { session, query, execute, dispose } = fixture();
			const failure = new Error('Local SQL failed');
			const fail = operation === 'query' ? query : execute;
			fail.mockRejectedValueOnce(failure);
			await expect(
				withCleanup(
					() => session[operation]('CUPBOARD_DB', 'invalid SQL'),
					() => session.dispose()
				)
			).rejects.toBe(failure);
			expect(dispose.mock.calls).toStrictEqual([[]]);
		}
	);
});
