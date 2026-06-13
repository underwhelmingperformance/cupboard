import { fakeCliUi } from '@cupboard/cli-ui/testing';
import type {
	RootListResponse,
	RootRemoveResponse,
	RootSetResponse,
	RootSummary
} from '@cupboard/protocol/retention';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	describeExpiry,
	type RootClient,
	runRootList,
	runRootRemove,
	runRootSet
} from './root.ts';

type SetRootInput = Parameters<RootClient['set']>[0];

const target = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';

describe('describeExpiry', () => {
	it.each([
		{ root: summary({ expired: false }), expected: 'permanent' },
		{
			root: summary({ expiresAt: '2026-01-08T00:00:00.000Z', expired: false }),
			expected: 'expires 2026-01-08 00:00 UTC'
		},
		{
			root: summary({ expiresAt: '2026-01-01T00:00:00.000Z', expired: true }),
			expected: 'expired (2026-01-01 00:00 UTC)'
		}
	])('describes "$expected"', ({ root, expected }) => {
		expect(describeExpiry(root)).toBe(expected);
	});
});

describe('runRootSet', () => {
	it('addresses the cache, sends the fields, and reports', async () => {
		const calls: SetRootInput[] = [];
		const results: ResultRow[][] = [];
		const response: RootSetResponse = summary({
			name: 'github:owner/repo/main',
			expiresAt: '2026-01-08T00:00:00.000Z',
			targets: [
				{
					storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
					storePath: target,
					present: true
				}
			]
		});

		await runRootSet(
			'_default',
			'github:owner/repo/main',
			[target],
			604_800,
			reporter(results),
			setRootClient(response, calls)
		);

		expect(calls).toStrictEqual([
			{
				cacheName: '_default',
				name: 'github:owner/repo/main',
				targets: [target],
				ttlSeconds: 604_800
			}
		]);
		expect(results).toStrictEqual([
			[
				{ label: 'Root', value: 'github:owner/repo/main' },
				{ label: 'Targets', value: '1' },
				{ label: 'Expiry', value: 'expires 2026-01-08 00:00 UTC' }
			]
		]);
	});

	it('rejects a target the client refuses', async () => {
		await expect(
			runRootSet('_default', 'main', ['/tmp/nope'], undefined, reporter([]), {
				set() {
					throw new Error('not a store path');
				},
				list() {
					throw new Error('client should not be called');
				},
				remove() {
					throw new Error('client should not be called');
				}
			})
		).rejects.toThrow();
	});
});

describe('runRootList', () => {
	it('reports a row per root', async () => {
		const results: ResultRow[][] = [];
		const response: RootListResponse = {
			roots: [
				summary({ name: 'main', targets: [presentTarget()] }),
				summary({
					name: 'pr-123',
					expiresAt: '2026-01-08T00:00:00.000Z',
					targets: [presentTarget()]
				})
			]
		};

		await runRootList('_default', reporter(results), listClient(response));

		expect(results).toStrictEqual([
			[
				{ label: 'main', value: '1 target(s); permanent' },
				{
					label: 'pr-123',
					value: '1 target(s); expires 2026-01-08 00:00 UTC'
				}
			]
		]);
	});

	it('reports nothing but an info line when there are no roots', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runRootList(
			'_default',
			reporter(results, infos),
			listClient({ roots: [] })
		);

		expect({ results, infos }).toStrictEqual({
			results: [],
			infos: ['No retention roots.']
		});
	});
});

describe('runRootRemove', () => {
	it('removes the root and reports the outcome once confirmed', async () => {
		const calls: { cacheName: string; name: string }[] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response: RootRemoveResponse = { name: 'pr-123', removed: true };

		await runRootRemove('builds', 'pr-123', ui, removeClient(response, calls));

		expect({ calls, results: captured.results }).toStrictEqual({
			calls: [{ cacheName: 'builds', name: 'pr-123' }],
			results: [
				{
					kind: 'root',
					data: response,
					rows: [
						{ label: 'Root', value: 'pr-123' },
						{ label: 'Removed', value: 'yes' }
					]
				}
			]
		});
	});

	it('leaves the root in place when the confirmation is declined', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runRootRemove(
			'builds',
			'pr-123',
			ui,
			removeClient({ name: 'pr-123', removed: true }, [])
		);

		expect({
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			results: [],
			cancellations: ['The retention root was left in place.']
		});
	});
});

function presentTarget(): RootSummary['targets'][number] {
	return {
		storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
		storePath: target,
		present: true
	};
}

function summary(overrides: Partial<RootSummary>): RootSummary {
	return {
		name: 'root',
		expired: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		targets: [],
		...overrides
	};
}

function setRootClient(
	response: RootSetResponse,
	calls: SetRootInput[]
): RootClient {
	return {
		set(input) {
			calls.push(input);

			return Promise.resolve(response);
		},
		list() {
			throw new Error('client should not be called');
		},
		remove() {
			throw new Error('client should not be called');
		}
	};
}

function listClient(response: RootListResponse): RootClient {
	return {
		set() {
			throw new Error('client should not be called');
		},
		list() {
			return Promise.resolve(response);
		},
		remove() {
			throw new Error('client should not be called');
		}
	};
}

function removeClient(
	response: RootRemoveResponse,
	calls: { cacheName: string; name: string }[]
): RootClient {
	return {
		set() {
			throw new Error('client should not be called');
		},
		list() {
			throw new Error('client should not be called');
		},
		remove(input) {
			calls.push(input);

			return Promise.resolve(response);
		}
	};
}

function reporter(results: ResultRow[][], infos: string[] = []): Reporter {
	return {
		phase(_label, body) {
			return Promise.resolve(
				body({
					fact() {
						return;
					}
				})
			);
		},
		result(payload) {
			results.push([...payload.rows]);
		},
		data() {
			return;
		},
		error() {
			return;
		},
		warn() {
			return;
		},
		info(message) {
			infos.push(message);
		}
	};
}
