import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import type {
	OidcTrustAddBody,
	OidcTrustListResponse,
	OidcTrustSummary
} from '@cupboard/protocol/oidc';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	type OidcTrustClient,
	runOidcTrustAdd,
	runOidcTrustList,
	runOidcTrustRemove,
	runOidcTrustShow
} from './oidc-trust.ts';

function summary(overrides: Partial<OidcTrustSummary>): OidcTrustSummary {
	return {
		id: 'rule-1',
		issuer: 'https://token.actions.githubusercontent.com',
		audience: 'https://cache.example.workers.dev',
		scope: 'write',
		claims: { repository_owner_id: '5678' },
		allowedRoots: ['github:owner/'],
		disabled: false,
		...overrides
	};
}

function trustClient(overrides: Partial<OidcTrustClient>): OidcTrustClient {
	return {
		list: () => Promise.resolve({ rules: [] }),
		get: ({ id }) => Promise.resolve(summary({ id })),
		add: (body) => Promise.resolve(summary({ ...body, id: 'rule-1' })),
		remove: ({ id }) => Promise.resolve({ id, removed: false }),
		...overrides
	};
}

describe('runOidcTrustList', () => {
	it('reports a row per rule, flagging disabled ones', async () => {
		const results: ResultRow[][] = [];
		const response: OidcTrustListResponse = {
			rules: [
				summary({
					id: 'owner',
					scope: 'admin',
					issuer: 'https://accounts.google.com'
				}),
				summary({ id: 'rule-1', disabled: true })
			]
		};

		await runOidcTrustList(reporter(results), {
			list: () => Promise.resolve(response)
		});

		expect(results).toStrictEqual([
			[
				{
					label: 'owner',
					value:
						'admin https://accounts.google.com aud=https://cache.example.workers.dev'
				},
				{
					label: 'rule-1',
					value:
						'write https://token.actions.githubusercontent.com aud=https://cache.example.workers.dev (disabled)'
				}
			]
		]);
	});

	it('reports nothing when there are no rules', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runOidcTrustList(reporter(results, infos), {
			list: () => Promise.resolve({ rules: [] })
		});

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No OIDC trust rules.']
		});
	});
});

describe('runOidcTrustAdd', () => {
	it('adds the rule and reports its summary', async () => {
		const calls: OidcTrustAddBody[] = [];
		const results: ResultRow[][] = [];
		const body: OidcTrustAddBody = {
			issuer: 'https://token.actions.githubusercontent.com',
			audience: 'https://cache.example.workers.dev',
			claims: { repository_owner_id: '5678', repository_id: '1234' },
			allowedRoots: ['github:owner/']
		};

		await runOidcTrustAdd(body, reporter(results), {
			add(added) {
				calls.push(added);
				return Promise.resolve(summary({ id: 'rule-1', claims: body.claims }));
			}
		});

		expect({ calls, results }).toStrictEqual({
			calls: [body],
			results: [
				[
					{ label: 'Rule', value: 'rule-1' },
					{
						label: 'Issuer',
						value: 'https://token.actions.githubusercontent.com'
					},
					{ label: 'Audience', value: 'https://cache.example.workers.dev' },
					{ label: 'Claims', value: 'repository_owner_id=5678' },
					{ label: '', value: 'repository_id=1234' },
					{ label: 'Scope', value: 'write' },
					{ label: 'Allowed roots', value: 'github:owner/' }
				]
			]
		});
	});
});

describe('runOidcTrustShow', () => {
	it('fetches the rule by id and reports its summary', async () => {
		const calls: { id: string }[] = [];
		const results: ResultRow[][] = [];

		await runOidcTrustShow('rule-1', reporter(results), {
			get(input) {
				calls.push(input);
				return Promise.resolve(
					summary({
						id: 'rule-1',
						claims: { repository_owner_id: '5678', repository_id: '1234' }
					})
				);
			}
		});

		expect({ calls, results }).toStrictEqual({
			calls: [{ id: 'rule-1' }],
			results: [
				[
					{ label: 'Rule', value: 'rule-1' },
					{
						label: 'Issuer',
						value: 'https://token.actions.githubusercontent.com'
					},
					{ label: 'Audience', value: 'https://cache.example.workers.dev' },
					{ label: 'Claims', value: 'repository_owner_id=5678' },
					{ label: '', value: 'repository_id=1234' },
					{ label: 'Scope', value: 'write' },
					{ label: 'Allowed roots', value: 'github:owner/' }
				]
			]
		});
	});
});

describe('runOidcTrustRemove', () => {
	it.each([
		{ removed: true, value: 'yes' },
		{ removed: false, value: 'not present' }
	])('reports removed=$removed once confirmed', async ({ removed, value }) => {
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response = { id: 'rule-1', removed };

		await runOidcTrustRemove(
			'rule-1',
			ui,
			trustClient({ remove: () => Promise.resolve(response) })
		);

		expect(captured.results).toStrictEqual([
			{
				kind: 'oidc-trust-rule',
				data: response,
				rows: [
					{ label: 'Rule', value: 'rule-1' },
					{ label: 'Removed', value }
				]
			}
		]);
	});

	it('leaves the rule in place when the confirmation is declined', async () => {
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runOidcTrustRemove('rule-1', ui, trustClient({}));

		expect({
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			results: [],
			cancellations: ['The trust rule was left in place.']
		});
	});
});
