import {
	capturingReporter as reporter,
	fakeCliUi
} from '@cupboard/cli-ui/testing';
import {
	oidcIssuerSchema,
	oidcSubjectSchema,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import {
	refreshSessionIdSchema,
	type RefreshSessionListResponse
} from '@cupboard/protocol/sessions';
import type { ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	runSessionList,
	runSessionRevoke,
	type SessionClient
} from './session.ts';

const sessionId = refreshSessionIdSchema.parse(
	'00000000-0000-4000-8000-000000000001'
);
const createdAt = isoTimestampSchema.parse('2026-01-01T00:00:00.000Z');
const expiresAt = isoTimestampSchema.parse('2026-01-31T00:00:00.000Z');

function sessionClient(overrides: Partial<SessionClient>): SessionClient {
	return {
		list: () => Promise.resolve({ sessions: [] }),
		revoke: ({ id }) => Promise.resolve({ id, revoked: false }),
		...overrides
	};
}

describe('runSessionList', () => {
	it('reports each session with its owner, showing an unrecorded owner as unknown', async () => {
		const results: ResultRow[][] = [];
		const unknownId = refreshSessionIdSchema.parse(
			'00000000-0000-4000-8000-000000000002'
		);
		const response: RefreshSessionListResponse = {
			sessions: [
				{
					id: sessionId,
					issuer: oidcIssuerSchema.parse('https://idp.example'),
					subject: oidcSubjectSchema.parse('alice'),
					rule: trustRuleIdSchema.parse('admin'),
					createdAt,
					expiresAt
				},
				{ id: unknownId, createdAt, expiresAt }
			]
		};

		await runSessionList(
			reporter(results),
			{ list: () => Promise.resolve(response) },
			'tenant'
		);

		expect(results).toStrictEqual([
			[
				{
					label: sessionId,
					value:
						'issuer https://idp.example; subject alice; rule admin; created 2026-01-01 00:00 UTC; expires 2026-01-31 00:00 UTC'
				},
				{
					label: unknownId,
					value:
						'issuer unknown; subject unknown; rule unknown; created 2026-01-01 00:00 UTC; expires 2026-01-31 00:00 UTC'
				}
			]
		]);
	});

	it('reports the keys below a tenant session and a session that a replay ended', async () => {
		const results: ResultRow[][] = [];
		const replayedId = refreshSessionIdSchema.parse(
			'00000000-0000-4000-8000-000000000003'
		);
		const replayedAt = isoTimestampSchema.parse('2026-01-02T00:00:00.000Z');
		const oneKeyId = refreshSessionIdSchema.parse(
			'00000000-0000-4000-8000-000000000004'
		);

		await runSessionList(
			reporter(results),
			{
				list: () =>
					Promise.resolve({
						sessions: [
							{ id: sessionId, createdAt, expiresAt, accessKeysBelow: 0 },
							{ id: oneKeyId, createdAt, expiresAt, accessKeysBelow: 1 },
							{
								id: replayedId,
								subject: oidcSubjectSchema.parse('alice'),
								createdAt,
								expiresAt,
								accessKeysBelow: 2,
								replayedAt
							}
						]
					})
			},
			'tenant'
		);

		expect(results).toStrictEqual([
			[
				{
					label: sessionId,
					value:
						'issuer unknown; subject unknown; rule unknown; created 2026-01-01 00:00 UTC; expires 2026-01-31 00:00 UTC; 0 access keys below it'
				},
				{
					label: oneKeyId,
					value:
						'issuer unknown; subject unknown; rule unknown; created 2026-01-01 00:00 UTC; expires 2026-01-31 00:00 UTC; 1 access key below it'
				},
				{
					label: replayedId,
					value:
						'issuer unknown; subject alice; rule unknown; created 2026-01-01 00:00 UTC; expires 2026-01-31 00:00 UTC; 2 access keys below it; ended at 2026-01-02 00:00 UTC by a refresh token that was used twice, so revoke it if it may have been stolen'
				}
			]
		]);
	});

	it('reports no sign-in sessions when the list is empty', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runSessionList(reporter(results, infos), sessionClient({}), 'tenant');

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No sign-in sessions.']
		});
	});
});

describe('runSessionRevoke', () => {
	it.each([
		{
			name: 'a live tenant session with keys',
			scope: 'tenant' as const,
			response: { id: sessionId, revoked: true, deletedAccessKeys: 2 },
			outcome: [
				{ label: 'Outcome', value: 'session revoked' },
				{ label: 'Access keys deleted', value: '2' }
			]
		},
		{
			name: 'an ended tenant session with keys',
			scope: 'tenant' as const,
			response: { id: sessionId, revoked: true, deletedAccessKeys: 1 },
			outcome: [
				{ label: 'Outcome', value: 'session revoked' },
				{ label: 'Access keys deleted', value: '1' }
			]
		},
		{
			name: 'an unknown tenant session',
			scope: 'tenant' as const,
			response: { id: sessionId, revoked: false, deletedAccessKeys: 0 },
			outcome: [
				{ label: 'Outcome', value: 'session not found' },
				{ label: 'Access keys deleted', value: '0' }
			]
		},
		{
			name: 'an operator session',
			scope: 'operator' as const,
			response: { id: sessionId, revoked: true },
			outcome: [{ label: 'Outcome', value: 'session revoked' }]
		}
	])('reports $name once confirmed', async ({ scope, response, outcome }) => {
		const calls: { id: string }[] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const noun = `${scope} sign-in session`;

		await runSessionRevoke(
			sessionId,
			ui,
			sessionClient({
				revoke(input) {
					calls.push(input);
					return Promise.resolve(response);
				}
			}),
			scope
		);

		expect({
			calls,
			confirms: captured.confirms.map((confirm) => confirm.message),
			results: captured.results
		}).toStrictEqual({
			calls: [{ id: sessionId }],
			confirms: [`Revoke ${noun} ${sessionId}?`],
			results: [
				{
					kind: 'session',
					title: `${noun.charAt(0).toUpperCase()}${noun.slice(1)}`,
					data: response,
					rows: [{ label: 'Session', value: sessionId }, ...outcome]
				}
			]
		});
	});

	it('leaves the session in place when the confirmation is declined', async () => {
		const calls: { id: string }[] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'no' });

		await runSessionRevoke(
			sessionId,
			ui,
			sessionClient({
				revoke(input) {
					calls.push(input);
					return Promise.resolve({ id: input.id, revoked: true });
				}
			}),
			'tenant'
		);

		expect({
			calls,
			results: captured.results,
			cancellations: captured.cancellations
		}).toStrictEqual({
			calls: [],
			results: [],
			cancellations: ['The session was left in place.']
		});
	});
});
