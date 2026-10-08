import { fakeCliUi } from '@cupboard/cli-ui/testing';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import {
	type CachedSession,
	readCachedSession,
	removeAllCachedSessions,
	removeCachedSession,
	type RemovedSession,
	writeCachedSession
} from '../auth/token-store.ts';
import {
	type CloudflareGrant,
	cloudflareOauthClientId
} from '../deploy/cloudflare-oauth.ts';
import {
	type GrantRemoval,
	readCachedGrant,
	removeCachedGrant,
	writeCachedGrant
} from '../deploy/grant-store.ts';
import { testWithConfigHome } from '../test-support.ts';

import {
	type LogoutDependencies,
	logoutInput,
	LogoutTargetError,
	runLogout
} from './logout.ts';

const tenant = 'https://cupboard.example.workers.dev/t/acme';
const other = 'https://cupboard.example.workers.dev/t/beta';
const deployment = 'https://cupboard.example.workers.dev';
const cloudflareRevocationEndpoint =
	'https://dash.cloudflare.com/oauth2/revoke';

function jwtSegment(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
	return `${jwtSegment({ alg: 'EdDSA', typ: 'JWT' })}.${jwtSegment(claims)}.signature`;
}

function sessionFor(target: string, refreshToken?: string): CachedSession {
	return {
		accessToken: jwt({ iss: target, aud: target }),
		...(refreshToken !== undefined && { refreshToken })
	};
}

const grant: CloudflareGrant = {
	accessToken: 'cloudflare-access',
	refreshToken: 'cloudflare-refresh',
	idToken: undefined,
	expiresAt: 1_700_000_000_000,
	subject: 'user-1'
};

interface RecordedRequest {
	readonly url: string;
	readonly redirect: RequestRedirect | undefined;
	readonly form: Readonly<Record<string, string>>;
}

/**
 * A fetcher that records each revocation request and responds with `respond`.
 */
function recordingFetcher(
	respond: () => Promise<Response> = () =>
		Promise.resolve(new Response(undefined, { status: StatusCodes.OK }))
): { readonly fetcher: typeof fetch; readonly requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	const fetcher: typeof fetch = (input, init) => {
		requests.push({
			url: input instanceof Request ? input.url : String(input),
			redirect: init?.redirect,
			form: Object.fromEntries(
				new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
			)
		});

		return respond();
	};

	return { fetcher, requests };
}

interface FakeState {
	readonly sessions: Map<string, CachedSession>;
	grant: CloudflareGrant | undefined;
}

function fakeDependencies(
	state: FakeState,
	fetcher: typeof fetch = recordingFetcher().fetcher
): LogoutDependencies {
	return {
		removeSession: (url) => {
			const session = state.sessions.get(url.href);
			state.sessions.delete(url.href);

			return Promise.resolve<RemovedSession>(
				session === undefined
					? { removal: 'absent' }
					: { removal: 'removed', session }
			);
		},
		removeAllSessions: () => {
			const sessions = state.sessions.values().toArray();
			state.sessions.clear();

			return Promise.resolve(sessions);
		},
		readGrant: () => Promise.resolve(state.grant),
		removeGrant: async (revoke): Promise<GrantRemoval> => {
			const current = state.grant;
			state.grant = undefined;

			return current === undefined
				? { removal: 'absent' }
				: { removal: 'removed', revocation: await revoke(current) };
		},
		fetcher
	};
}

function cupboardRevocation(target: string, token: string): RecordedRequest {
	return {
		url: `${target}/revoke`,
		redirect: 'manual',
		form: { token, token_type_hint: 'refresh_token' }
	};
}

describe('logoutInput', () => {
	it('signs out of one URL', () => {
		const url = new URL(tenant);

		expect(logoutInput(url, {})).toStrictEqual({
			sessions: { kind: 'url', url },
			cloudflareSignIn: 'keep'
		});
	});

	it('signs out of everything, including Cloudflare', () => {
		expect(
			logoutInput(undefined, { all: true, cloudflare: true })
		).toStrictEqual({ sessions: { kind: 'all' }, cloudflareSignIn: 'remove' });
	});

	it('removes only the Cloudflare sign-in', () => {
		expect(logoutInput(undefined, { cloudflare: true })).toStrictEqual({
			sessions: { kind: 'none' },
			cloudflareSignIn: 'remove'
		});
	});

	it.each([
		['nothing to remove', undefined, {}],
		['a URL with --all', new URL(tenant), { all: true }]
	])('refuses %s', (_name, url, options) => {
		expect(() => logoutInput(url, options)).toThrow(LogoutTargetError);
	});
});

describe('runLogout', () => {
	it('removes one session, revokes its refresh token and warns that the Cloudflare sign-in remains', async () => {
		const state: FakeState = {
			sessions: new Map([
				[tenant, sessionFor(tenant, 'refresh-acme')],
				[other, sessionFor(other, 'refresh-beta')]
			]),
			grant
		};
		const { fetcher, requests } = recordingFetcher();
		const { ui, captured } = fakeCliUi();

		const result = await runLogout(
			logoutInput(new URL(tenant), {}),
			ui.reporter(),
			fakeDependencies(state, fetcher)
		);

		expect({
			result,
			requests,
			remaining: state.sessions.keys().toArray(),
			results: captured.results,
			warnings: captured.warnings.length
		}).toStrictEqual({
			result: {
				url: tenant,
				sessionsRemoved: 1,
				cloudflareSignIn: 'kept',
				revoked: {
					sessions: [{ target: tenant, revocation: 'revoked' }]
				}
			},
			requests: [cupboardRevocation(tenant, 'refresh-acme')],
			remaining: [other],
			results: [
				{
					kind: 'logout',
					title: 'Signed out on this machine',
					data: result,
					rows: [
						{
							label: tenant,
							value: 'saved sign-in removed; refresh token revoked'
						},
						{ label: 'Cloudflare sign-in', value: 'still cached' }
					]
				}
			],
			warnings: 1
		});
	});

	it.each([
		{
			name: 'an error status',
			respond: () =>
				Promise.resolve(
					new Response(undefined, { status: StatusCodes.SERVICE_UNAVAILABLE })
				)
		},
		{
			name: 'a redirect',
			respond: () =>
				Promise.resolve(
					new Response(undefined, {
						status: StatusCodes.TEMPORARY_REDIRECT,
						headers: { location: 'https://elsewhere.example/revoke' }
					})
				)
		},
		{
			name: 'a network failure',
			respond: () => Promise.reject(new TypeError('fetch failed'))
		}
	])(
		'removes the session and warns when revocation fails with $name',
		async ({ respond }) => {
			const state: FakeState = {
				sessions: new Map([[tenant, sessionFor(tenant, 'refresh-acme')]]),
				grant: undefined
			};
			const { fetcher, requests } = recordingFetcher(respond);
			const { ui, captured } = fakeCliUi();

			const result = await runLogout(
				logoutInput(new URL(tenant), {}),
				ui.reporter(),
				fakeDependencies(state, fetcher)
			);

			expect({
				revoked: result.revoked,
				requests,
				remaining: state.sessions.size,
				warnings: captured.warnings.length
			}).toStrictEqual({
				revoked: { sessions: [{ target: tenant, revocation: 'failed' }] },
				requests: [cupboardRevocation(tenant, 'refresh-acme')],
				remaining: 0,
				warnings: 1
			});
		}
	);

	it.each([
		{
			name: 'a tenant session',
			target: tenant,
			session: sessionFor(tenant, 'refresh-acme'),
			hint: ' A tenant administrator can end a tenant session with `cupboard session revoke`.'
		},
		{
			name: 'a deployment session',
			target: deployment,
			session: {
				accessToken: jwt({ iss: deployment, aud: 'cupboard-control' }),
				refreshToken: 'refresh-operator'
			},
			hint: ' An operator can end a deployment session with `cupboard deployment session revoke`.'
		}
	])(
		'names the revoke command for $name when its revocation fails',
		async ({ target, session, hint }) => {
			const state: FakeState = {
				sessions: new Map([[new URL(target).href, session]]),
				grant: undefined
			};
			const { fetcher } = recordingFetcher(() =>
				Promise.resolve(
					new Response(undefined, { status: StatusCodes.SERVICE_UNAVAILABLE })
				)
			);
			const { ui, captured } = fakeCliUi();

			await runLogout(
				logoutInput(new URL(target), {}),
				ui.reporter(),
				fakeDependencies(state, fetcher)
			);

			expect(captured.warnings).toStrictEqual([
				`Could not confirm revocation of some refresh tokens. A copied token might remain usable.${hint}`
			]);
		}
	);

	it('is idempotent for a URL with no session', async () => {
		const state: FakeState = { sessions: new Map(), grant: undefined };
		const { fetcher, requests } = recordingFetcher();
		const { ui, captured } = fakeCliUi();

		const result = await runLogout(
			logoutInput(new URL(tenant), {}),
			ui.reporter(),
			fakeDependencies(state, fetcher)
		);

		expect({
			result,
			requests,
			results: captured.results,
			warnings: captured.warnings.length
		}).toStrictEqual({
			result: {
				url: tenant,
				sessionsRemoved: 0,
				cloudflareSignIn: 'absent',
				revoked: { sessions: [] }
			},
			requests: [],
			results: [
				{
					kind: 'logout',
					title: 'Signed out on this machine',
					data: result,
					rows: [{ label: tenant, value: 'no saved sign-in' }]
				}
			],
			warnings: 0
		});
	});

	it('removes a session when the cached Cloudflare grant cannot be read', async () => {
		const state: FakeState = {
			sessions: new Map([
				[tenant, sessionFor(tenant)],
				[other, sessionFor(other)]
			]),
			grant
		};
		const { fetcher, requests } = recordingFetcher();
		const { ui, captured } = fakeCliUi();
		const result = await runLogout(
			logoutInput(new URL(tenant), {}),
			ui.reporter(),
			{
				...fakeDependencies(state, fetcher),
				readGrant: () => Promise.reject(new Error('EACCES'))
			}
		);

		expect({
			result,
			requests,
			remaining: state.sessions.keys().toArray(),
			grant: state.grant,
			results: captured.results,
			warnings: captured.warnings
		}).toStrictEqual({
			result: {
				url: tenant,
				sessionsRemoved: 1,
				cloudflareSignIn: 'unreadable',
				revoked: {
					sessions: [{ target: tenant, revocation: 'no-refresh-token' }]
				}
			},
			requests: [],
			remaining: [other],
			grant,
			results: [
				{
					kind: 'logout',
					title: 'Signed out on this machine',
					data: result,
					rows: [
						{
							label: tenant,
							value: 'saved sign-in removed; no refresh token to revoke'
						},
						{ label: 'Cloudflare sign-in', value: 'could not be checked' }
					]
				}
			],
			warnings: [
				'Could not check the cached Cloudflare sign-in. Run `cupboard logout --cloudflare` to remove the sign-in.'
			]
		});
	});

	it('removes every session and the Cloudflare sign-in, revoking each refresh token', async () => {
		const state: FakeState = {
			sessions: new Map([
				[tenant, sessionFor(tenant, 'refresh-acme')],
				[other, sessionFor(other, 'refresh-beta')],
				[
					deployment,
					{
						accessToken: jwt({ iss: deployment, aud: 'cupboard-control' }),
						refreshToken: 'refresh-operator'
					}
				]
			]),
			grant
		};
		const { fetcher, requests } = recordingFetcher();
		const { ui, captured } = fakeCliUi();

		const result = await runLogout(
			logoutInput(undefined, { all: true, cloudflare: true }),
			ui.reporter(),
			fakeDependencies(state, fetcher)
		);

		expect({
			result,
			requests,
			state: { sessions: state.sessions.size, grant: state.grant },
			results: captured.results,
			warnings: captured.warnings.length
		}).toStrictEqual({
			result: {
				sessionsRemoved: 3,
				cloudflareSignIn: 'removed',
				revoked: {
					sessions: [
						{ target: tenant, revocation: 'revoked' },
						{ target: other, revocation: 'revoked' },
						{ target: deployment, revocation: 'revoked' }
					],
					cloudflareSignIn: 'revoked'
				}
			},
			requests: [
				{
					url: cloudflareRevocationEndpoint,
					redirect: 'manual',
					form: {
						token: 'cloudflare-refresh',
						token_type_hint: 'refresh_token',
						client_id: cloudflareOauthClientId
					}
				},
				cupboardRevocation(tenant, 'refresh-acme'),
				cupboardRevocation(other, 'refresh-beta'),
				cupboardRevocation(deployment, 'refresh-operator')
			],
			state: { sessions: 0, grant: undefined },
			results: [
				{
					kind: 'logout',
					title: 'Signed out on this machine',
					data: result,
					rows: [
						{ label: 'Saved sign-ins removed', value: '3' },
						{ label: tenant, value: 'refresh token revoked' },
						{ label: other, value: 'refresh token revoked' },
						{ label: deployment, value: 'refresh token revoked' },
						{
							label: 'Cloudflare sign-in',
							value: 'removed; refresh token revoked'
						}
					]
				}
			],
			warnings: 0
		});
	});
});

describe('runLogout against the on-disk stores', () => {
	testWithConfigHome(
		'deletes the cached session and Cloudflare sign-in files after revoking them',
		async () => {
			const tenantUrl = new URL(tenant);
			const otherUrl = new URL(other);
			await writeCachedSession(sessionFor(tenant, 'refresh-acme'), tenantUrl);
			await writeCachedSession(sessionFor(other), otherUrl);
			await writeCachedGrant(grant);
			const { fetcher, requests } = recordingFetcher();
			const { ui } = fakeCliUi();

			const result = await runLogout(
				logoutInput(tenantUrl, { cloudflare: true }),
				ui.reporter(),
				{
					removeSession: removeCachedSession,
					removeAllSessions: removeAllCachedSessions,
					readGrant: readCachedGrant,
					removeGrant: removeCachedGrant,
					fetcher
				}
			);

			expect({
				result,
				requests: requests.map((request) => request.url),
				tenant: await readCachedSession(tenantUrl),
				other: (await readCachedSession(otherUrl)) !== undefined,
				grant: await readCachedGrant()
			}).toStrictEqual({
				result: {
					url: tenant,
					sessionsRemoved: 1,
					cloudflareSignIn: 'removed',
					revoked: {
						sessions: [{ target: tenant, revocation: 'revoked' }],
						cloudflareSignIn: 'revoked'
					}
				},
				requests: [cloudflareRevocationEndpoint, `${tenant}/revoke`],
				tenant: undefined,
				other: true,
				grant: undefined
			});
		}
	);

	testWithConfigHome(
		'deletes the Cloudflare sign-in file when Cloudflare refuses the revocation',
		async () => {
			await writeCachedGrant(grant);
			const { fetcher } = recordingFetcher(() =>
				Promise.resolve(
					new Response(undefined, { status: StatusCodes.BAD_REQUEST })
				)
			);
			const { ui } = fakeCliUi();

			const result = await runLogout(
				logoutInput(undefined, { cloudflare: true }),
				ui.reporter(),
				{
					removeSession: removeCachedSession,
					removeAllSessions: removeAllCachedSessions,
					readGrant: readCachedGrant,
					removeGrant: removeCachedGrant,
					fetcher
				}
			);

			expect({
				result,
				grant: await readCachedGrant()
			}).toStrictEqual({
				result: {
					sessionsRemoved: 0,
					cloudflareSignIn: 'removed',
					revoked: { sessions: [], cloudflareSignIn: 'failed' }
				},
				grant: undefined
			});
		}
	);
});
