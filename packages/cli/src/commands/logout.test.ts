import { fakeCliUi } from '@cupboard/cli-ui/testing';
import type { TokenResponse } from '@cupboard/protocol/oidc';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { cachedOwnerProvider } from '../auth/auth.ts';
import type { Removal } from '../auth/secret-file.ts';
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

function removal(wasPresent: boolean): Removal {
	return wasPresent ? 'removed' : 'absent';
}

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

function tenantRevocation(target: string, token: string): RecordedRequest {
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
			requests: [tenantRevocation(tenant, 'refresh-acme')],
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
				requests: [tenantRevocation(tenant, 'refresh-acme')],
				remaining: 0,
				warnings: 1
			});
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
				[other, sessionFor(other, 'refresh-beta')]
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
				sessionsRemoved: 2,
				cloudflareSignIn: 'removed',
				revoked: {
					sessions: [
						{ target: tenant, revocation: 'revoked' },
						{ target: other, revocation: 'revoked' }
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
				tenantRevocation(tenant, 'refresh-acme'),
				tenantRevocation(other, 'refresh-beta')
			],
			state: { sessions: 0, grant: undefined },
			results: [
				{
					kind: 'logout',
					title: 'Signed out on this machine',
					data: result,
					rows: [
						{ label: 'Saved sign-ins removed', value: '2' },
						{ label: tenant, value: 'refresh token revoked' },
						{ label: other, value: 'refresh token revoked' },
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

/**
 * A lock that runs its actions one at a time, in the order of the calls.
 */
class MemoryLock {
	private tail: Promise<boolean> = Promise.resolve(true);

	async run<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		const released = Promise.withResolvers<boolean>();

		this.tail = released.promise;

		try {
			await previous;

			return await action();
		} finally {
			released.resolve(true);
		}
	}
}

/**
 * Lets every task that is ready to run do so.
 */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) {
		await new Promise((next) => setImmediate(next));
	}
}

async function outcomeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;

		return 'resolved';
	} catch (error) {
		return error instanceof Error ? error.name : 'rejected';
	}
}

describe('runLogout with a concurrent session renewal', () => {
	const now = 1_700_000_000_000;
	const past = now / 1000 - 60;
	const future = now / 1000 + 3600;
	const tenantUrl = new URL(tenant);

	// The renewal starts while logout is paused before its first or its second
	// store operation. Whichever it is, logout has to leave no session and no
	// Cloudflare sign-in behind.
	it.each([
		{ step: 0, renewal: 'resolved' },
		{ step: 1, renewal: 'OwnerLoginRequiredError' }
	])(
		'leaves nothing cached when the renewal starts at logout step $step',
		async ({ step, renewal }) => {
			const sessions = new Map<string, CachedSession>([
				[tenantUrl.href, { accessToken: jwt({ exp: past }) }]
			]);
			let cachedGrant: CloudflareGrant | undefined = {
				...grant,
				idToken: jwt({ sub: 'user-1', exp: future })
			};
			const grantLock = new MemoryLock();
			const sessionLocks = new Map<string, MemoryLock>();
			const sessionLock = (target: URL): MemoryLock => {
				const lock = sessionLocks.get(target.href) ?? new MemoryLock();

				sessionLocks.set(target.href, lock);

				return lock;
			};
			const exchangeStarted = Promise.withResolvers<boolean>();
			const exchangeReleased = Promise.withResolvers<boolean>();
			const logoutPaused = Promise.withResolvers<boolean>();
			const logoutResumed = Promise.withResolvers<boolean>();
			let logoutCalls = 0;
			const pauseAtStep = async (): Promise<void> => {
				const call = logoutCalls;

				logoutCalls += 1;

				if (call !== step) {
					return;
				}

				logoutPaused.resolve(true);
				await logoutResumed.promise;
			};
			const exchanged: TokenResponse = {
				access_token: jwt({ exp: future }),
				token_type: 'Bearer',
				expires_in: 600
			};
			const provider = cachedOwnerProvider(tenantUrl, {
				client: {
					tokenRefresh: () => Promise.reject(new Error('no refresh token')),
					tokenExchange: async () => {
						exchangeStarted.resolve(true);
						await exchangeReleased.promise;

						return exchanged;
					}
				},
				grantChain: {
					readGrant: () => Promise.resolve(cachedGrant),
					writeGrant: (written) => {
						cachedGrant = written;

						return Promise.resolve();
					},
					withGrantLock: (action, signal) =>
						grantLock.run(() => action(signal)),
					refreshGrant: () => Promise.resolve(undefined),
					now: () => now
				},
				readSession: (target) => Promise.resolve(sessions.get(target.href)),
				writeSession: (session, target) => {
					sessions.set(target.href, session);

					return Promise.resolve();
				},
				withSessionLock: (target, action, signal) =>
					sessionLock(target).run(() => action(signal)),
				now: () => now
			});
			const logoutDependencies: LogoutDependencies = {
				removeSession: async (url) => {
					await pauseAtStep();

					return sessionLock(url).run(() => {
						const session = sessions.get(url.href);
						sessions.delete(url.href);

						return Promise.resolve<RemovedSession>(
							session === undefined
								? { removal: 'absent' }
								: { removal: 'removed', session }
						);
					});
				},
				removeAllSessions: async () => {
					await pauseAtStep();
					const removed: CachedSession[] = [];

					for (const [href, session] of sessions) {
						await sessionLock(new URL(href)).run(() => {
							sessions.delete(href);
							removed.push(session);

							return Promise.resolve();
						});
					}

					return removed;
				},
				readGrant: async () => {
					await pauseAtStep();

					return cachedGrant;
				},
				removeGrant: async () => {
					await pauseAtStep();

					return grantLock.run(() => {
						const wasPresent = cachedGrant !== undefined;

						cachedGrant = undefined;

						return Promise.resolve({ removal: removal(wasPresent) });
					});
				},
				fetcher: recordingFetcher().fetcher
			};

			const logout = outcomeOf(
				runLogout(
					logoutInput(undefined, { all: true, cloudflare: true }),
					fakeCliUi().ui.reporter(),
					logoutDependencies
				)
			);

			await logoutPaused.promise;
			const renewed = outcomeOf(provider.get());

			await Promise.race([exchangeStarted.promise, renewed, settle()]);
			logoutResumed.resolve(true);
			await Promise.race([logout, settle()]);
			exchangeReleased.resolve(true);

			expect({
				logout: await logout,
				renewal: await renewed,
				sessions: sessions.keys().toArray(),
				cloudflareSignIn: cachedGrant
			}).toStrictEqual({
				logout: 'resolved',
				renewal,
				sessions: [],
				cloudflareSignIn: undefined
			});
		}
	);
});
