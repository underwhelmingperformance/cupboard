import { fakeCliUi } from '@cupboard/cli-ui/testing';
import type { TokenResponse } from '@cupboard/protocol/oidc';
import { describe, expect, it } from 'vitest';

import { cachedOwnerProvider } from '../auth/auth.ts';
import type { Removal } from '../auth/secret-file.ts';
import {
	type CachedSession,
	readCachedSession,
	removeAllCachedSessions,
	removeCachedSession,
	writeCachedSession
} from '../auth/token-store.ts';
import type { CloudflareGrant } from '../deploy/cloudflare-oauth.ts';
import {
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

function jwtSegment(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
	return `${jwtSegment({ alg: 'EdDSA', typ: 'JWT' })}.${jwtSegment(claims)}.signature`;
}

const grant: CloudflareGrant = {
	accessToken: 'cloudflare-access',
	refreshToken: undefined,
	idToken: undefined,
	expiresAt: 1_700_000_000_000,
	subject: 'user-1'
};

function removal(wasPresent: boolean): Removal {
	return wasPresent ? 'removed' : 'absent';
}

function fakeDependencies(state: {
	sessions: Set<string>;
	grant: boolean;
}): LogoutDependencies {
	return {
		removeSession: (url) =>
			Promise.resolve(removal(state.sessions.delete(url.href))),
		removeAllSessions: () => {
			const count = state.sessions.size;
			state.sessions.clear();

			return Promise.resolve(count);
		},
		readGrant: () => Promise.resolve(state.grant ? grant : undefined),
		removeGrant: () => {
			const wasPresent = state.grant;
			state.grant = false;

			return Promise.resolve(removal(wasPresent));
		}
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
	it('removes one session and warns that the Cloudflare sign-in remains', async () => {
		const state = { sessions: new Set([tenant, other]), grant: true };
		const { ui, captured } = fakeCliUi();

		const result = await runLogout(
			logoutInput(new URL(tenant), {}),
			ui.reporter(),
			fakeDependencies(state)
		);

		expect({
			result,
			remaining: [...state.sessions],
			results: captured.results,
			warnings: captured.warnings.length
		}).toStrictEqual({
			result: {
				url: tenant,
				sessionsRemoved: 1,
				cloudflareSignIn: 'kept',
				revoked: false
			},
			remaining: [other],
			results: [
				{
					kind: 'logout',
					title: 'Signed out on this machine',
					data: result,
					rows: [
						{ label: tenant, value: 'saved sign-in removed' },
						{ label: 'Cloudflare sign-in', value: 'still cached' }
					]
				}
			],
			warnings: 1
		});
	});

	it('is idempotent for a URL with no session', async () => {
		const state = { sessions: new Set<string>(), grant: false };
		const { ui, captured } = fakeCliUi();

		const result = await runLogout(
			logoutInput(new URL(tenant), {}),
			ui.reporter(),
			fakeDependencies(state)
		);

		expect({
			result,
			results: captured.results,
			warnings: captured.warnings.length
		}).toStrictEqual({
			result: {
				url: tenant,
				sessionsRemoved: 0,
				cloudflareSignIn: 'absent',
				revoked: false
			},
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
		const state = { sessions: new Set([tenant, other]), grant: true };
		const { ui, captured } = fakeCliUi();
		const result = await runLogout(
			logoutInput(new URL(tenant), {}),
			ui.reporter(),
			{
				...fakeDependencies(state),
				readGrant: () => Promise.reject(new Error('EACCES'))
			}
		);

		expect({
			result,
			remaining: [...state.sessions],
			grant: state.grant,
			results: captured.results,
			warnings: captured.warnings
		}).toStrictEqual({
			result: {
				url: tenant,
				sessionsRemoved: 1,
				cloudflareSignIn: 'unreadable',
				revoked: false
			},
			remaining: [other],
			grant: true,
			results: [
				{
					kind: 'logout',
					title: 'Signed out on this machine',
					data: result,
					rows: [
						{ label: tenant, value: 'saved sign-in removed' },
						{ label: 'Cloudflare sign-in', value: 'could not be checked' }
					]
				}
			],
			warnings: [
				'Could not check the cached Cloudflare sign-in. Run `cupboard logout --cloudflare` to remove the sign-in.'
			]
		});
	});

	it('removes every session and the Cloudflare sign-in', async () => {
		const state = { sessions: new Set([tenant, other]), grant: true };
		const { ui, captured } = fakeCliUi();

		const result = await runLogout(
			logoutInput(undefined, { all: true, cloudflare: true }),
			ui.reporter(),
			fakeDependencies(state)
		);

		expect({
			result,
			state: { sessions: state.sessions.size, grant: state.grant },
			results: captured.results,
			warnings: captured.warnings.length
		}).toStrictEqual({
			result: {
				sessionsRemoved: 2,
				cloudflareSignIn: 'removed',
				revoked: false
			},
			state: { sessions: 0, grant: false },
			results: [
				{
					kind: 'logout',
					title: 'Signed out on this machine',
					data: result,
					rows: [
						{ label: 'Saved sign-ins removed', value: '2' },
						{ label: 'Cloudflare sign-in', value: 'removed' }
					]
				}
			],
			warnings: 0
		});
	});
});

describe('runLogout against the on-disk stores', () => {
	testWithConfigHome(
		'deletes the cached session and Cloudflare sign-in files',
		async () => {
			const tenantUrl = new URL(tenant);
			const otherUrl = new URL(other);
			await writeCachedSession(
				{ accessToken: jwt({ iss: tenant, aud: tenant }) },
				tenantUrl
			);
			await writeCachedSession(
				{ accessToken: jwt({ iss: other, aud: other }) },
				otherUrl
			);
			await writeCachedGrant(grant);
			const { ui } = fakeCliUi();

			const result = await runLogout(
				logoutInput(tenantUrl, { cloudflare: true }),
				ui.reporter(),
				{
					removeSession: removeCachedSession,
					removeAllSessions: removeAllCachedSessions,
					readGrant: readCachedGrant,
					removeGrant: removeCachedGrant
				}
			);

			expect({
				result,
				tenant: await readCachedSession(tenantUrl),
				other: (await readCachedSession(otherUrl)) !== undefined,
				grant: await readCachedGrant()
			}).toStrictEqual({
				result: {
					url: tenant,
					sessionsRemoved: 1,
					cloudflareSignIn: 'removed',
					revoked: false
				},
				tenant: undefined,
				other: true,
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

					return sessionLock(url).run(() =>
						Promise.resolve(removal(sessions.delete(url.href)))
					);
				},
				removeAllSessions: async () => {
					await pauseAtStep();
					let removed = 0;

					for (const href of sessions.keys()) {
						await sessionLock(new URL(href)).run(() => {
							removed += sessions.delete(href) ? 1 : 0;

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

						return Promise.resolve(removal(wasPresent));
					});
				}
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
