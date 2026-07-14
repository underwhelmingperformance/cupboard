import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import type {
	GracePolicyListResponse,
	GracePolicyRemoveResponse,
	GracePolicySummary,
	RetentionPolicyAddBody,
	RetentionPolicyListResponse,
	RetentionPolicyRemoveResponse,
	RetentionPolicySummary
} from '@cupboard/protocol/retention';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	type PolicyClient,
	runGracePolicyAdd,
	runGracePolicyList,
	runGracePolicyRemove,
	runPolicyAdd,
	runPolicyList,
	runPolicyRemove
} from './policy.ts';

function policyClient(overrides: Partial<PolicyClient>): PolicyClient {
	return {
		list: () => Promise.resolve({ policies: [] }),
		add: (body) => Promise.resolve({ id: 'p1', ...body }),
		remove: ({ id }) => Promise.resolve({ id, removed: false }),
		graceList: () => Promise.resolve({ policies: [] }),
		graceAdd: (body) => Promise.resolve({ id: 'g1', createdAt: '', ...body }),
		graceRemove: ({ id }) => Promise.resolve({ id, removed: false }),
		...overrides
	};
}

describe('runPolicyList', () => {
	it('reports a row per policy', async () => {
		const results: ResultRow[][] = [];
		const response: RetentionPolicyListResponse = {
			policies: [
				{
					id: 'p1',
					scope: 'root-name-prefix',
					pattern: 'pr-',
					ttlSeconds: 604_800
				}
			]
		};

		await runPolicyList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[{ label: 'p1', value: 'root-name-prefix pr-; 604,800s' }]
		]);
	});

	it('reports an info line when there are no policies', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runPolicyList(reporter(results, infos), {
			list: () => Promise.resolve({ policies: [] })
		});

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No retention policies.']
		});
	});
});

describe('runPolicyAdd', () => {
	it('builds a cache-scoped body and reports the policy', async () => {
		const calls: RetentionPolicyAddBody[] = [];
		const results: ResultRow[][] = [];
		const summary: RetentionPolicySummary = {
			id: 'p1',
			scope: 'cache',
			pattern: 'builds',
			ttlSeconds: 1_209_600
		};

		await runPolicyAdd('cache', 'builds', 1_209_600, reporter(results), {
			add(body) {
				calls.push(body);
				return Promise.resolve(summary);
			}
		});

		expect({ calls, results }).toStrictEqual({
			calls: [{ scope: 'cache', pattern: 'builds', ttlSeconds: 1_209_600 }],
			results: [
				[
					{ label: 'Policy', value: 'p1' },
					{ label: 'Scope', value: 'cache' },
					{ label: 'Pattern', value: 'builds' },
					{ label: 'TTL (seconds)', value: '1,209,600' }
				]
			]
		});
	});
});

describe('runPolicyRemove', () => {
	it('removes a policy and reports the outcome once confirmed', async () => {
		const calls: { id: string }[] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response: RetentionPolicyRemoveResponse = { id: 'p1', removed: true };

		await runPolicyRemove(
			'p1',
			ui,
			policyClient({
				remove(input) {
					calls.push(input);
					return Promise.resolve(response);
				}
			})
		);

		expect({ calls, results: captured.results }).toStrictEqual({
			calls: [{ id: 'p1' }],
			results: [
				{
					kind: 'retention-policy',
					data: response,
					rows: [
						{ label: 'Policy', value: 'p1' },
						{ label: 'Removed', value: 'yes' }
					]
				}
			]
		});
	});

	it('leaves the policy in place when the confirmation is declined', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runPolicyRemove('p1', ui, policyClient({}));

		expect({
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			results: [],
			cancellations: ['The retention policy was left in place.']
		});
	});
});

describe('runGracePolicyList', () => {
	it.each([
		{
			name: 'a named prefix',
			policy: {
				id: 'g1',
				cachePrefix: 'pr-',
				graceSeconds: 86_400,
				createdAt: '2026-01-01T00:00:00.000Z'
			},
			row: { label: 'g1', value: 'pr-; 86,400s' }
		},
		{
			name: 'the tenant-wide default prefix',
			policy: {
				id: 'g1',
				cachePrefix: '',
				graceSeconds: 0,
				createdAt: '2026-01-01T00:00:00.000Z'
			},
			row: { label: 'g1', value: '(all caches); 0s' }
		}
	])('reports a row for $name', async ({ policy, row }) => {
		const results: ResultRow[][] = [];
		const response: GracePolicyListResponse = { policies: [policy] };

		await runGracePolicyList(reporter(results), {
			graceList: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([[row]]);
	});

	it('reports an info line when there are no grace policies', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runGracePolicyList(reporter(results, infos), {
			graceList: () => Promise.resolve({ policies: [] })
		});

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No retention grace policies.']
		});
	});
});

describe('runGracePolicyAdd', () => {
	it.each([
		{
			name: 'a named prefix',
			cachePrefix: 'pr-',
			graceSeconds: 86_400,
			prefixRow: { label: 'Cache prefix', value: 'pr-' },
			graceRow: { label: 'Grace (seconds)', value: '86,400' }
		},
		{
			name: 'the tenant-wide default prefix',
			cachePrefix: '',
			graceSeconds: 0,
			prefixRow: { label: 'Cache prefix', value: '(all caches)' },
			graceRow: { label: 'Grace (seconds)', value: '0' }
		}
	])(
		'builds the body and reports the policy for $name',
		async ({ cachePrefix, graceSeconds, prefixRow, graceRow }) => {
			const calls: { cachePrefix: string; graceSeconds: number }[] = [];
			const results: ResultRow[][] = [];
			const summary: GracePolicySummary = {
				id: 'g1',
				cachePrefix,
				graceSeconds,
				createdAt: '2026-01-01T00:00:00.000Z'
			};

			await runGracePolicyAdd(cachePrefix, graceSeconds, reporter(results), {
				graceAdd(body) {
					calls.push(body);
					return Promise.resolve(summary);
				}
			});

			expect({ calls, results }).toStrictEqual({
				calls: [{ cachePrefix, graceSeconds }],
				results: [[{ label: 'Policy', value: 'g1' }, prefixRow, graceRow]]
			});
		}
	);
});

describe('runGracePolicyRemove', () => {
	it('removes a grace policy and reports the outcome once confirmed', async () => {
		const calls: { id: string }[] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response: GracePolicyRemoveResponse = { id: 'g1', removed: true };

		await runGracePolicyRemove(
			'g1',
			ui,
			policyClient({
				graceRemove(input) {
					calls.push(input);
					return Promise.resolve(response);
				}
			})
		);

		expect({ calls, results: captured.results }).toStrictEqual({
			calls: [{ id: 'g1' }],
			results: [
				{
					kind: 'grace-policy',
					data: response,
					rows: [
						{ label: 'Policy', value: 'g1' },
						{ label: 'Removed', value: 'yes' }
					]
				}
			]
		});
	});

	it('leaves the grace policy in place when the confirmation is declined', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runGracePolicyRemove('g1', ui, policyClient({}));

		expect({
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			results: [],
			cancellations: ['The retention grace policy was left in place.']
		});
	});
});
