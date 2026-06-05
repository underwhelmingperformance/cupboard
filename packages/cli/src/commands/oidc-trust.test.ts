import type {
	OidcTrustAddBody,
	OidcTrustListResponse,
	OidcTrustSummary
} from '@cupboard/protocol/oidc';
import { describe, expect, it } from 'vitest';

import type { AccessCredential } from '../client/client.ts';
import type { Reporter, ResultRow } from '../reporter.ts';

import {
	type OidcTrustClient,
	runOidcTrustAdd,
	runOidcTrustList,
	runOidcTrustRemove
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

function uncalled(): never {
	throw new Error('client should not be called');
}

function trustClient(overrides: Partial<OidcTrustClient>): OidcTrustClient {
	return {
		listOidcTrust: uncalled,
		addOidcTrust: uncalled,
		removeOidcTrust: uncalled,
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

		await runOidcTrustList(
			'admin-token',
			reporter(results),
			trustClient({ listOidcTrust: () => Promise.resolve(response) })
		);

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

		await runOidcTrustList(
			'admin-token',
			reporter(results, infos),
			trustClient({ listOidcTrust: () => Promise.resolve({ rules: [] }) })
		);

		expect({ results, infos }).toStrictEqual({
			results: [],
			infos: ['No OIDC trust rules.']
		});
	});
});

describe('runOidcTrustAdd', () => {
	it('adds the rule and reports its summary', async () => {
		const calls: { token: AccessCredential; body: OidcTrustAddBody }[] = [];
		const results: ResultRow[][] = [];
		const body: OidcTrustAddBody = {
			issuer: 'https://token.actions.githubusercontent.com',
			audience: 'https://cache.example.workers.dev',
			claims: { repository_owner_id: '5678' },
			allowedRoots: ['github:owner/']
		};

		await runOidcTrustAdd(
			body,
			'admin-token',
			reporter(results),
			trustClient({
				addOidcTrust(token, added) {
					calls.push({ token, body: added });
					return Promise.resolve(summary({ id: 'rule-1' }));
				}
			})
		);

		expect({ calls, results }).toStrictEqual({
			calls: [{ token: 'admin-token', body }],
			results: [
				[
					{ label: 'Rule', value: 'rule-1' },
					{
						label: 'Issuer',
						value: 'https://token.actions.githubusercontent.com'
					},
					{ label: 'Audience', value: 'https://cache.example.workers.dev' },
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
	])('reports removed=$removed', async ({ removed, value }) => {
		const results: ResultRow[][] = [];

		await runOidcTrustRemove(
			'rule-1',
			'admin-token',
			reporter(results),
			trustClient({
				removeOidcTrust: () => Promise.resolve({ id: 'rule-1', removed })
			})
		);

		expect(results).toStrictEqual([
			[
				{ label: 'Rule', value: 'rule-1' },
				{ label: 'Removed', value }
			]
		]);
	});
});
