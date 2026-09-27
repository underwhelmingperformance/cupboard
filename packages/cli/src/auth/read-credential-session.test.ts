import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { abortable } from '../abort.ts';

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

	it('keeps the valid credential during a transient renewal failure', async () => {
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
					return Promise.reject(new Error('temporary exchange failure'));
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
	});

	it('aborts owned work with a read-auth error before the last credential expires', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const fixture = file();
		const entered = Promise.withResolvers<undefined>();
		let requests = 0;
		const session = withRenewingReadCredential(
			options(() => {
				requests += 1;

				return requests === 1
					? Promise.resolve(lease('first', 4000))
					: Promise.reject(new Error('temporary exchange failure'));
			}, fixture.credentialFile),
			async ({ signal }) => {
				entered.resolve(undefined);
				await abortable(Promise.withResolvers<undefined>().promise, signal);
			}
		);

		await entered.promise;
		const outcome = expect(session).rejects.toBeInstanceOf(
			ReadCredentialRenewalError
		);
		await vi.advanceTimersByTimeAsync(3000);
		await outcome;
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
