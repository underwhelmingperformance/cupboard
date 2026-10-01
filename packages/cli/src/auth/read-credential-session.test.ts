import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { abortable } from '../abort.ts';
import { CupboardHttpError } from '../errors.ts';

import {
	type ReadCredentialFile,
	type ReadCredentialLease,
	ReadCredentialPublicationError,
	ReadCredentialRenewalError,
	withRenewingReadCredential
} from './read-credential-session.ts';

const url = new URL('https://cupboard.example.workers.dev/t/acme');

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
