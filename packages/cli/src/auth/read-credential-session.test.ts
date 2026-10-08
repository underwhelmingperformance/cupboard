import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalHref } from '@cupboard/nix-store/url';
import { readTokenPasswordPrefix } from '@cupboard/protocol/read-access';
import { subjectBindingProblems } from '@cupboard/protocol/subject-binding';
import { StatusCodes } from 'http-status-codes';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { abortable } from '../abort.ts';
import { audienceSchema } from '../audience.ts';
import { authExitCode, CupboardHttpError } from '../errors.ts';

import { GithubOidcAudienceRefusedError } from './github-oidc.ts';
import { issueGithubReadCredential } from './github-read-credential.ts';
import {
	type ReadCredentialFile,
	type ReadCredentialLease,
	ReadCredentialPublicationError,
	ReadCredentialRenewalError,
	withRenewingReadCredential
} from './read-credential-session.ts';

const url = new URL('https://cupboard.example.workers.dev/t/acme');
const audience = audienceSchema.parse('https://cache.example.workers.dev');

const readAccessGranted = {
	access_token: 'read-token',
	token_type: 'Bearer',
	expires_in: 10,
	authorization_details: [],
	read_resources: [
		{
			type: 'cupboard_cache',
			cache: { kind: 'default' },
			mode: 'content',
			state: { kind: 'existing', access: 'private', priority: 40 }
		}
	]
};

function requestHref(input: string | URL | Request): string {
	if (typeof input === 'string') {
		return input;
	}

	return input instanceof URL ? input.href : input.url;
}

/**
 * A GitHub Actions token endpoint and a tenant token endpoint. The tenant
 * endpoint returns the bodies of `responses` in order: a body with an
 * `access_token` succeeds, and any other body is a 400 refusal.
 */
function readAccessServer(responses: readonly Record<string, unknown>[]): {
	readonly fetcher: typeof fetch;
	readonly exchanges: () => number;
} {
	let exchanges = 0;
	const fetcher = (input: string | URL | Request): Promise<Response> => {
		if (new URL(requestHref(input)).origin === 'https://actions.example.com') {
			return Promise.resolve(Response.json({ value: 'github-subject' }));
		}

		const body = responses[exchanges] ?? {};
		exchanges += 1;

		return Promise.resolve(
			'access_token' in body
				? Response.json(body)
				: Response.json(body, { status: StatusCodes.BAD_REQUEST })
		);
	};

	return { fetcher, exchanges: () => exchanges };
}

function issueFromGithub(
	fetcher: typeof fetch,
	signal: AbortSignal
): Promise<ReadCredentialLease> {
	return issueGithubReadCredential({
		tenantUrl: url,
		audience,
		resources: [
			{ type: 'cupboard_cache', cache: { kind: 'default' }, mode: 'content' }
		],
		signal,
		fetcher,
		environment: {
			requestUrl: 'https://actions.example.com/token',
			requestToken: 'request-bearer'
		}
	});
}

function httpRefusal(error: unknown): unknown {
	if (!(error instanceof CupboardHttpError)) {
		return error;
	}

	return { status: error.status, oauthError: error.oauthError };
}

function describeFailure(error: unknown): unknown {
	if (error instanceof GithubOidcAudienceRefusedError) {
		return {
			name: error.name,
			target: error.target,
			audience: error.audience,
			cause: httpRefusal(error.cause),
			exitCode: error.exitCode
		};
	}

	if (error instanceof ReadCredentialRenewalError) {
		return {
			name: error.name,
			cause: httpRefusal(error.cause),
			exitCode: error.exitCode
		};
	}

	return error;
}

function lease(password: string, expiresAtMs: number): ReadCredentialLease {
	return { user: 'cupboard-oidc', password, expiresAtMs };
}

function file() {
	const writes: string[] = [];
	let isRemoved = false;
	const credentialFile: ReadCredentialFile = {
		path: '/private/netrc',
		replace: (credential) => {
			writes.push(credential.password);

			return Promise.resolve();
		},
		remove: () => {
			isRemoved = true;

			return Promise.resolve();
		}
	};

	return { credentialFile, writes, isRemoved: () => isRemoved };
}

async function failureOf(operation: Promise<unknown>): Promise<unknown> {
	try {
		return await operation;
	} catch (error) {
		return error;
	}
}

function options(
	issue: (signal: AbortSignal) => Promise<ReadCredentialLease>,
	credentialFile: ReadCredentialFile
) {
	return {
		url,
		issue,
		createFile: () => Promise.resolve(credentialFile),
		now: Date.now,
		wait: (milliseconds: number, signal: AbortSignal) =>
			abortable(
				new Promise<void>((resolve) => {
					setTimeout(resolve, milliseconds);
				}),
				signal
			),
		renewalMarginMs: 5000,
		safetyMarginMs: 1000,
		retryDelayMs: 1000
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe('withRenewingReadCredential', () => {
	it('writes a private real netrc file and removes it after the operation', async () => {
		const result = await withRenewingReadCredential(
			{
				url,
				existingNetrc: 'machine other.example login another password static\n',
				issue: () =>
					Promise.resolve(lease('temporary-token', Date.now() + 900_000))
			},
			async ({ netrcFile }) => {
				const fileStat = await stat(netrcFile);
				const directoryStat = await stat(path.dirname(netrcFile));

				return {
					netrcFile,
					contents: await readFile(netrcFile, 'utf8'),
					fileMode: fileStat.mode & 0o777,
					directoryMode: directoryStat.mode & 0o777
				};
			}
		);

		expect({
			contents: result.contents,
			fileMode: result.fileMode,
			directoryMode: result.directoryMode,
			fileRemoved: !existsSync(result.netrcFile)
		}).toStrictEqual({
			contents:
				'machine cupboard.example.workers.dev login cupboard-oidc password temporary-token\n' +
				'machine other.example login another password static\n',
			fileMode: 0o600,
			directoryMode: 0o700,
			fileRemoved: true
		});
	});

	it('uses RUNNER_TEMP for temporary read credentials', async () => {
		const runnerTemporary = await mkdtemp(
			path.join(tmpdir(), 'cupboard-runner-')
		);
		vi.stubEnv('RUNNER_TEMP', runnerTemporary);

		try {
			const directory = await withRenewingReadCredential(
				{
					url,
					issue: () => Promise.resolve(lease('token', Date.now() + 900_000))
				},
				({ netrcFile }) =>
					Promise.resolve(path.dirname(path.dirname(netrcFile)))
			);
			expect(directory).toBe(runnerTemporary);
		} finally {
			await rm(runnerTemporary, { recursive: true, force: true });
		}
	});

	it.each([400, 401, 403, 404])(
		'stops immediately on permanent HTTP %s renewal refusal and preserves its cause',
		async (status) => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const fixture = file();
			const entered = Promise.withResolvers<undefined>();
			const refusal = new CupboardHttpError(
				'POST',
				'/oauth/token',
				status,
				'read access refused'
			);
			let requests = 0;
			const session = withRenewingReadCredential(
				options(() => {
					requests += 1;
					return requests === 1
						? Promise.resolve(lease('first', 10_000))
						: Promise.reject(refusal);
				}, fixture.credentialFile),
				async ({ signal }) => {
					entered.resolve(undefined);
					await abortable(Promise.withResolvers<undefined>().promise, signal);
				}
			);
			await entered.promise;
			const outcome = failureOf(session);
			await vi.advanceTimersByTimeAsync(9000);
			const error = await outcome;
			expect(error).toBeInstanceOf(ReadCredentialRenewalError);
			if (!(error instanceof ReadCredentialRenewalError)) {
				throw new Error('Expected a read renewal error');
			}
			expect({
				cause: error.cause,
				exitCode: error.exitCode,
				requests,
				writes: fixture.writes,
				removed: fixture.isRemoved()
			}).toStrictEqual({
				cause: refusal,
				exitCode: 77,
				requests: 2,
				writes: ['first'],
				removed: true
			});
		}
	);

	it.each([
		{
			refusal: {
				error: 'invalid_grant',
				problem: subjectBindingProblems.unbound
			},
			expected: {
				name: 'GithubOidcAudienceRefusedError',
				target: canonicalHref(url),
				audience,
				cause: {
					status: StatusCodes.BAD_REQUEST,
					oauthError: {
						error: 'invalid_grant',
						problem: subjectBindingProblems.unbound
					}
				},
				exitCode: authExitCode
			}
		},
		{
			refusal: { error: 'invalid_request', problem: 'subject-token-untrusted' },
			expected: {
				name: 'ReadCredentialRenewalError',
				cause: {
					status: StatusCodes.BAD_REQUEST,
					oauthError: {
						error: 'invalid_request',
						problem: 'subject-token-untrusted'
					}
				},
				exitCode: authExitCode
			}
		}
	])(
		'stops without a retry when renewal of a GitHub read credential is refused with $refusal.problem',
		async ({ refusal, expected }) => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const fixture = file();
			const entered = Promise.withResolvers<undefined>();
			const server = readAccessServer([readAccessGranted, refusal]);
			const session = withRenewingReadCredential(
				options(
					(signal) => issueFromGithub(server.fetcher, signal),
					fixture.credentialFile
				),
				async ({ signal }) => {
					entered.resolve(undefined);
					await abortable(Promise.withResolvers<undefined>().promise, signal);
				}
			);
			await entered.promise;
			const outcome = failureOf(session);
			await vi.advanceTimersByTimeAsync(9000);

			expect({
				error: describeFailure(await outcome),
				exchanges: server.exchanges(),
				writes: fixture.writes,
				removed: fixture.isRemoved()
			}).toStrictEqual({
				error: expected,
				exchanges: 2,
				writes: [`${readTokenPasswordPrefix}read-token`],
				removed: true
			});
		}
	);

	it('reports a GitHub read credential refused as unbound before work starts', async () => {
		const fixture = file();
		const server = readAccessServer([
			{ error: 'invalid_grant', problem: subjectBindingProblems.unbound }
		]);
		let isEntered = false;

		const error = await failureOf(
			withRenewingReadCredential(
				options(
					(signal) => issueFromGithub(server.fetcher, signal),
					fixture.credentialFile
				),
				() => {
					isEntered = true;

					return Promise.resolve();
				}
			)
		);

		expect({
			error: describeFailure(error),
			exchanges: server.exchanges(),
			isEntered,
			writes: fixture.writes
		}).toStrictEqual({
			error: {
				name: 'GithubOidcAudienceRefusedError',
				target: canonicalHref(url),
				audience,
				cause: {
					status: StatusCodes.BAD_REQUEST,
					oauthError: {
						error: 'invalid_grant',
						problem: subjectBindingProblems.unbound
					}
				},
				exitCode: authExitCode
			},
			exchanges: 1,
			isEntered: false,
			writes: []
		});
	});

	it('installs the first credential before work, renews independently, and removes the file after work', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const fixture = file();
		const entered = Promise.withResolvers<undefined>();
		const complete = Promise.withResolvers<string>();
		const issued = [lease('first', 10_000), lease('second', 20_000)];
		const session = withRenewingReadCredential(
			options(() => {
				const next = issued.shift();
				if (next === undefined) {
					throw new Error('No read credential remains');
				}

				return Promise.resolve(next);
			}, fixture.credentialFile),
			async ({ netrcFile, signal }) => {
				entered.resolve(undefined);

				return { netrcFile, value: await abortable(complete.promise, signal) };
			}
		);

		await entered.promise;
		expect({
			writes: fixture.writes,
			removed: fixture.isRemoved()
		}).toStrictEqual({
			writes: ['first'],
			removed: false
		});

		await vi.advanceTimersByTimeAsync(5000);
		expect(fixture.writes).toStrictEqual(['first', 'second']);
		complete.resolve('done');

		await expect(session).resolves.toStrictEqual({
			netrcFile: '/private/netrc',
			value: 'done'
		});
		expect(fixture.isRemoved()).toBe(true);
	});

	it.each([408, 429, 503])(
		'keeps the valid credential during transient HTTP %s renewal failure',
		async (status) => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const fixture = file();
			const entered = Promise.withResolvers<undefined>();
			const complete = Promise.withResolvers<undefined>();
			let requests = 0;
			const session = withRenewingReadCredential(
				options(() => {
					requests += 1;

					if (requests === 2) {
						return Promise.reject(
							new CupboardHttpError(
								'POST',
								'/oauth/token',
								status,
								'temporary exchange failure'
							)
						);
					}

					return Promise.resolve(
						requests === 1 ? lease('first', 10_000) : lease('second', 20_000)
					);
				}, fixture.credentialFile),
				async ({ signal }) => {
					entered.resolve(undefined);
					await abortable(complete.promise, signal);
				}
			);

			await entered.promise;
			await vi.advanceTimersByTimeAsync(5000);
			expect(fixture.writes).toStrictEqual(['first']);
			await vi.advanceTimersByTimeAsync(1000);
			expect(fixture.writes).toStrictEqual(['first', 'second']);

			complete.resolve(undefined);
			await session;
			expect(fixture.isRemoved()).toBe(true);
		}
	);

	it('preserves the last transient failure when aborting before credential expiry', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const fixture = file();
		const entered = Promise.withResolvers<undefined>();
		const temporaryError = new CupboardHttpError(
			'POST',
			'/oauth/token',
			503,
			'temporary exchange failure'
		);
		let requests = 0;
		const session = withRenewingReadCredential(
			options(() => {
				requests += 1;

				return requests === 1
					? Promise.resolve(lease('first', 4000))
					: Promise.reject(temporaryError);
			}, fixture.credentialFile),
			async ({ signal }) => {
				entered.resolve(undefined);
				await abortable(Promise.withResolvers<undefined>().promise, signal);
			}
		);

		await entered.promise;
		const outcome = failureOf(session);
		await vi.advanceTimersByTimeAsync(3000);
		expect(await outcome).toMatchObject({
			cause: temporaryError,
			exitCode: 75
		});
		expect({
			writes: fixture.writes,
			removed: fixture.isRemoved()
		}).toStrictEqual({
			writes: ['first'],
			removed: true
		});
	});

	it('keeps the last refusal when a subsequent renewal stalls until expiry', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const fixture = file();
		const entered = Promise.withResolvers<undefined>();
		const pending = Promise.withResolvers<ReadCredentialLease>();
		const temporaryError = new CupboardHttpError(
			'POST',
			'/oauth/token',
			503,
			'temporary exchange failure'
		);
		let requests = 0;
		const session = withRenewingReadCredential(
			options(() => {
				requests += 1;
				if (requests === 1) {
					return Promise.resolve(lease('first', 10_000));
				}
				if (requests === 2) {
					return Promise.reject(temporaryError);
				}
				return pending.promise;
			}, fixture.credentialFile),
			async ({ signal }) => {
				entered.resolve(undefined);
				await abortable(Promise.withResolvers<undefined>().promise, signal);
			}
		);
		await entered.promise;
		const outcome = failureOf(session);
		await vi.advanceTimersByTimeAsync(9000);
		const error = await outcome;
		if (!(error instanceof ReadCredentialRenewalError)) {
			throw new Error('Expected a read renewal error');
		}
		expect({
			cause: error.cause,
			exitCode: error.exitCode,
			requests,
			writes: fixture.writes,
			removed: fixture.isRemoved()
		}).toStrictEqual({
			cause: temporaryError,
			exitCode: 75,
			requests: 3,
			writes: ['first'],
			removed: true
		});
	});

	it('waits for a cancelled renewal before removing its file', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const fixture = file();
		const entered = Promise.withResolvers<undefined>();
		const complete = Promise.withResolvers<undefined>();
		const pending = Promise.withResolvers<ReadCredentialLease>();
		let requests = 0;
		const session = withRenewingReadCredential(
			options(() => {
				requests += 1;

				return requests === 1
					? Promise.resolve(lease('first', 6000))
					: pending.promise;
			}, fixture.credentialFile),
			async ({ signal }) => {
				entered.resolve(undefined);
				await abortable(complete.promise, signal);
			}
		);

		await entered.promise;
		await vi.advanceTimersByTimeAsync(1000);
		expect(requests).toBe(2);
		complete.resolve(undefined);
		await session;
		pending.resolve(lease('late', 20_000));
		await Promise.resolve();
		expect({
			writes: fixture.writes,
			removed: fixture.isRemoved()
		}).toStrictEqual({
			writes: ['first'],
			removed: true
		});
	});

	it('aborts work before expiry when publishing a renewed credential stalls', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const fixture = file();
		const entered = Promise.withResolvers<undefined>();
		const pending = Promise.withResolvers<undefined>();
		let abortedAt: number | undefined;
		const credentialFile: ReadCredentialFile = {
			...fixture.credentialFile,
			replace: (credential, signal) => {
				if (credential.password === 'first') {
					return fixture.credentialFile.replace(credential, signal);
				}

				return abortable(pending.promise, signal);
			}
		};
		let requests = 0;
		const session = withRenewingReadCredential(
			options(() => {
				requests += 1;

				return Promise.resolve(
					requests === 1 ? lease('first', 10_000) : lease('second', 20_000)
				);
			}, credentialFile),
			async ({ signal }) => {
				signal.addEventListener('abort', () => {
					abortedAt = Date.now();
				});
				entered.resolve(undefined);
				await abortable(Promise.withResolvers<undefined>().promise, signal);
			}
		);

		await entered.promise;
		const outcome = expect(session).rejects.toBeInstanceOf(
			ReadCredentialPublicationError
		);
		await vi.advanceTimersByTimeAsync(9000);
		await outcome;
		expect({
			abortedAt,
			writes: fixture.writes,
			removed: fixture.isRemoved()
		}).toStrictEqual({ abortedAt: 9000, writes: ['first'], removed: true });
	});

	it('preserves an operation failure if credential-file cleanup also fails', async () => {
		const operationError = new Error('child exited 17');
		const fixture = file();
		const credentialFile: ReadCredentialFile = {
			...fixture.credentialFile,
			remove: () => Promise.reject(new Error('cleanup failed'))
		};
		const session = withRenewingReadCredential(
			options(
				() => Promise.resolve(lease('first', Date.now() + 900_000)),
				credentialFile
			),
			() => Promise.reject(operationError)
		);

		await expect(session).rejects.toBe(operationError);
	});
});
