import { fakeCliUi } from '@cupboard/cli-ui/testing';
import type {
	RetentionPolicyAddBody,
	RetentionPolicyListResponse,
	RetentionPolicyRemoveResponse,
	RetentionPolicySummary
} from '@cupboard/protocol/retention';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	type PolicyClient,
	runPolicyAdd,
	runPolicyList,
	runPolicyRemove
} from './policy.ts';

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

function uncalledClient(): never {
	throw new Error('client should not be called');
}

function policyClient(overrides: Partial<PolicyClient>): PolicyClient {
	return {
		list: uncalledClient,
		add: uncalledClient,
		remove: uncalledClient,
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

		await runPolicyList(
			reporter(results),
			policyClient({ list: () => Promise.resolve(response) })
		);

		expect(results).toStrictEqual([
			[{ label: 'p1', value: 'root-name-prefix pr-; 604,800s' }]
		]);
	});

	it('reports an info line when there are no policies', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runPolicyList(
			reporter(results, infos),
			policyClient({ list: () => Promise.resolve({ policies: [] }) })
		);

		expect({ results, infos }).toStrictEqual({
			results: [],
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

		await runPolicyAdd(
			'cache',
			'builds',
			1_209_600,
			reporter(results),
			policyClient({
				add(body) {
					calls.push(body);
					return Promise.resolve(summary);
				}
			})
		);

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
