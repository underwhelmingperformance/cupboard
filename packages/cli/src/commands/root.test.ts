import type {
	RootListResponse,
	RootRemoveResponse,
	RootSetBody,
	RootSetResponse,
	RootSummary
} from '@cupboard/protocol/retention';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import type { AccessCredential } from '../client/client.ts';

import {
	describeExpiry,
	type RootClient,
	runRootList,
	runRootRemove,
	runRootSet
} from './root.ts';

type SetRootFields = { readonly name: string } & RootSetBody;

const target = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';

describe('describeExpiry', () => {
	it.each([
		{ root: summary({ expired: false }), expected: 'permanent' },
		{
			root: summary({ expiresAt: '2026-01-08T00:00:00.000Z', expired: false }),
			expected: 'expires 2026-01-08T00:00:00.000Z'
		},
		{
			root: summary({ expiresAt: '2026-01-01T00:00:00.000Z', expired: true }),
			expected: 'expired (2026-01-01T00:00:00.000Z)'
		}
	])('describes "$expected"', ({ root, expected }) => {
		expect(describeExpiry(root)).toBe(expected);
	});
});

describe('runRootSet', () => {
	it('validates, sends the fields with the token, and reports', async () => {
		const calls: { token: AccessCredential; fields: SetRootFields }[] = [];
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
			'github:owner/repo/main',
			[target],
			604_800,
			'admin-token',
			reporter(results),
			setRootClient(response, calls)
		);

		expect(calls).toStrictEqual([
			{
				token: 'admin-token',
				fields: {
					name: 'github:owner/repo/main',
					targets: [target],
					ttlSeconds: 604_800
				}
			}
		]);
		expect(results).toStrictEqual([
			[
				{ label: 'Root', value: 'github:owner/repo/main' },
				{ label: 'Targets', value: '1' },
				{ label: 'Expiry', value: 'expires 2026-01-08T00:00:00.000Z' }
			]
		]);
	});

	it('rejects a target that is not a store path', async () => {
		await expect(
			runRootSet('main', ['/tmp/nope'], undefined, 't', reporter([]), {
				setRoot() {
					throw new Error('client should not be called');
				},
				listRoots() {
					throw new Error('client should not be called');
				},
				removeRoot() {
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

		await runRootList('admin-token', reporter(results), listClient(response));

		expect(results).toStrictEqual([
			[
				{ label: 'main', value: '1 target(s); permanent' },
				{
					label: 'pr-123',
					value: '1 target(s); expires 2026-01-08T00:00:00.000Z'
				}
			]
		]);
	});

	it('reports nothing but an info line when there are no roots', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runRootList(
			'admin-token',
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
	it('removes the root and reports the outcome', async () => {
		const calls: { token: AccessCredential; name: string }[] = [];
		const results: ResultRow[][] = [];

		await runRootRemove(
			'pr-123',
			'admin-token',
			reporter(results),
			removeClient({ name: 'pr-123', removed: true }, calls)
		);

		expect(calls).toStrictEqual([{ token: 'admin-token', name: 'pr-123' }]);
		expect(results).toStrictEqual([
			[
				{ label: 'Root', value: 'pr-123' },
				{ label: 'Removed', value: 'yes' }
			]
		]);
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
	calls: { token: AccessCredential; fields: SetRootFields }[]
): RootClient {
	return {
		setRoot(token, name, body) {
			calls.push({ token, fields: { name, ...body } });

			return Promise.resolve(response);
		},
		listRoots() {
			throw new Error('client should not be called');
		},
		removeRoot() {
			throw new Error('client should not be called');
		}
	};
}

function listClient(response: RootListResponse): RootClient {
	return {
		setRoot() {
			throw new Error('client should not be called');
		},
		listRoots() {
			return Promise.resolve(response);
		},
		removeRoot() {
			throw new Error('client should not be called');
		}
	};
}

function removeClient(
	response: RootRemoveResponse,
	calls: { token: AccessCredential; name: string }[]
): RootClient {
	return {
		setRoot() {
			throw new Error('client should not be called');
		},
		listRoots() {
			throw new Error('client should not be called');
		},
		removeRoot(token, name) {
			calls.push({ token, name });

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
		result(rows) {
			results.push([...rows]);
		},
		warn() {
			return;
		},
		info(message) {
			infos.push(message);
		}
	};
}
