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

		await runSessionList(reporter(results), {
			list: () => Promise.resolve(response)
		});

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

	it('reports no sign-in sessions when the list is empty', async () => {
		const results: ResultRow[][] = [];
		const infos: string[] = [];

		await runSessionList(reporter(results, infos), sessionClient({}));

		expect({ results, infos }).toStrictEqual({
			results: [[]],
			infos: ['No sign-in sessions.']
		});
	});
});

describe('runSessionRevoke', () => {
	it.each([
		{ revoked: true, value: 'session revoked' },
		{ revoked: false, value: 'session not found' }
	])('reports revoked=$revoked once confirmed', async ({ revoked, value }) => {
		const calls: { id: string }[] = [];
		const { ui, captured } = fakeCliUi({ confirm: 'yes' });
		const response = { id: sessionId, revoked };

		await runSessionRevoke(
			sessionId,
			ui,
			sessionClient({
				revoke(input) {
					calls.push(input);
					return Promise.resolve(response);
				}
			})
		);

		expect({ calls, results: captured.results }).toStrictEqual({
			calls: [{ id: sessionId }],
			results: [
				{
					kind: 'session',
					title: 'Tenant sign-in session',
					data: response,
					rows: [
						{ label: 'Session', value: sessionId },
						{ label: 'Outcome', value }
					]
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
			})
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
