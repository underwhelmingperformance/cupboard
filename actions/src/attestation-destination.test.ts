import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { storePathSchema } from '@cupboard/nix-store/scalars';
import { createGithubReporter } from '@cupboard/reporter';
import { initialiseTracing, stopTracing } from '@cupboard/shared/node-tracing';
import { probeDeadlineMs } from '@cupboard/shared/timeout';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import { currentHttpAttemptTraceHeaders } from '../../packages/shared/src/fetch-observation.ts';
import {
	stalledResponse,
	untilOnlyStalledRequestPending
} from '../../tests/support/stalled-request.ts';

import {
	requirePublishedSubjects,
	resolveAttestationDestination
} from './attestation-destination.ts';
import {
	CommittedSubjectInvalidError,
	CommittedSubjectUnavailableError,
	MissingInputError,
	ReadPasswordRequiredError,
	ReadUserRequiredError,
	SubjectNarHashMovedError
} from './errors.ts';

const tenantUrl = 'https://cache.example.test/t/acme';
const appName = '0123456789abcdfghijklmnpqrsvwxyz-app';
const appPath = storePathSchema.parse(`/nix/store/${appName}`);
const appDigest = 'bb'.repeat(32);
const appNarInfoUrl = `${tenantUrl}/cache/builds/0123456789abcdfghijklmnpqrsvwxyz.narinfo`;
const destination = resolveAttestationDestination(
	{ url: tenantUrl, cache: 'builds' },
	{}
);

function publishedNarInfo(
	name: string,
	digestByte: number,
	options?: { readonly deriver?: string; readonly storeDirectory?: string }
): string {
	const deriver = options === undefined ? `${name}.drv` : options.deriver;
	const hash = NixSha256Hash.fromDigest(
		Buffer.alloc(32, digestByte)
	).toString();

	return [
		`StorePath: ${options?.storeDirectory ?? '/nix/store'}/${name}`,
		`URL: nar/${name}.nar.zst`,
		'Compression: zstd',
		`FileHash: ${hash}`,
		'FileSize: 1',
		`NarHash: ${hash}`,
		'NarSize: 1',
		'References: ',
		...(deriver === undefined ? [] : [`Deriver: ${deriver}`]),
		''
	].join('\n');
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	if (input instanceof URL) {
		return input.href;
	}

	return typeof input === 'string' ? input : input.url;
}

describe('resolveAttestationDestination', () => {
	it('reads the read password from the environment', () => {
		expect(
			resolveAttestationDestination(
				{ url: tenantUrl, cache: 'builds', readUser: 'reader' },
				{ READ_PASSWORD: 'secret' }
			)
		).toStrictEqual({
			url: new URL(tenantUrl),
			cache: { kind: 'named', name: 'builds' },
			readUser: 'reader',
			readPassword: 'secret'
		});
	});

	it.each([
		{ name: 'the destination URL', given: {}, errorType: MissingInputError },
		{
			name: 'a read password for the read user',
			given: { url: tenantUrl, readUser: 'reader' },
			errorType: ReadPasswordRequiredError
		},
		{
			name: 'a read user for the read password',
			given: { url: tenantUrl, readPassword: 'secret' },
			errorType: ReadUserRequiredError
		}
	])('requires $name', ({ given, errorType }) => {
		expect(() => resolveAttestationDestination(given, {})).toThrow(errorType);
	});
});

describe('requirePublishedSubjects', () => {
	const subjects = [{ storePath: appPath, sha256: appDigest }];

	it('reads each narinfo with the read credential and the trace context', async () => {
		const requests: {
			url: string;
			authorization?: string;
			propagated: boolean;
		}[] = [];
		initialiseTracing();

		try {
			await requirePublishedSubjects(
				subjects,
				resolveAttestationDestination(
					{
						url: tenantUrl,
						cache: 'builds',
						readUser: 'reader',
						readPassword: 'secret'
					},
					{}
				),
				createGithubReporter(),
				{
					fetch: (input, init) => {
						const url = requestUrl(input);
						const traceparent =
							currentHttpAttemptTraceHeaders(new URL(url).origin)
								?.traceparent ?? '';
						requests.push({
							url,
							propagated: /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u.test(
								traceparent
							),
							authorization:
								new Headers(init?.headers).get('authorization') ?? undefined
						});

						return Promise.resolve(
							new Response(publishedNarInfo(appName, 0xbb))
						);
					}
				}
			);

			expect(requests).toStrictEqual([
				{
					url: appNarInfoUrl,
					propagated: true,
					authorization: `Basic ${Buffer.from('reader:secret').toString('base64')}`
				}
			]);
		} finally {
			await stopTracing();
		}
	});

	it('reads a narinfo again after it hangs past the deadline', async () => {
		const requests: string[] = [];

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const pending = requirePublishedSubjects(
				subjects,
				destination,
				createGithubReporter(),
				{
					fetch: (input, init) => {
						requests.push(requestUrl(input));

						return requests.length === 1
							? stalledResponse(init?.signal)
							: Promise.resolve(new Response(publishedNarInfo(appName, 0xbb)));
					}
				}
			);
			const settled = expect(pending).resolves.toBeUndefined();
			await untilOnlyStalledRequestPending(() => requests.length === 1);
			await vi.advanceTimersByTimeAsync(probeDeadlineMs + 5000);
			await settled;

			expect(requests).toStrictEqual([appNarInfoUrl, appNarInfoUrl]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('uses the read-session credential from the Nix netrc file', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-destination-')
		);
		const netrcFile = path.join(directory, 'netrc');
		const authorizations: (string | undefined)[] = [];

		try {
			await writeFile(
				netrcFile,
				'machine cache.example.test login cupboard-oidc password token\n'
			);
			vi.stubEnv('NIX_CONFIG', `netrc-file = ${netrcFile}`);

			await requirePublishedSubjects(
				subjects,
				destination,
				createGithubReporter(),
				{
					fetch: (_input, init) => {
						authorizations.push(
							new Headers(init?.headers).get('authorization') ?? undefined
						);

						return Promise.resolve(
							new Response(publishedNarInfo(appName, 0xbb))
						);
					}
				}
			);

			expect(authorizations).toStrictEqual([
				`Basic ${Buffer.from('cupboard-oidc:token').toString('base64')}`
			]);
		} finally {
			vi.unstubAllEnvs();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		{
			name: 'another deriver',
			options: { deriver: '4123456789abcdfghijklmnpqrsvwxyz-older.drv' }
		},
		{ name: 'no deriver', options: {} }
	])('accepts a narinfo with $name', async ({ options }) => {
		await expect(
			requirePublishedSubjects(subjects, destination, createGithubReporter(), {
				fetch: () =>
					Promise.resolve(
						new Response(publishedNarInfo(appName, 0xbb, options))
					)
			})
		).resolves.toBeUndefined();
	});

	it.each([StatusCodes.NOT_FOUND, StatusCodes.UNAUTHORIZED])(
		'refuses a subject whose narinfo read returns HTTP %s',
		async (status) => {
			await expect(
				requirePublishedSubjects(
					subjects,
					destination,
					createGithubReporter(),
					{
						fetch: () => Promise.resolve(new Response(undefined, { status }))
					}
				)
			).rejects.toStrictEqual(
				new CommittedSubjectUnavailableError(appPath, status)
			);
		}
	);

	it.each([
		{ name: 'malformed metadata', body: 'not a narinfo' },
		{
			name: 'metadata after a byte order mark',
			body: `\u{FEFF}${publishedNarInfo(appName, 0xbb)}`
		},
		{
			name: 'metadata for another path',
			body: publishedNarInfo('4123456789abcdfghijklmnpqrsvwxyz-other', 0xbb)
		},
		{
			name: 'metadata for the same basename in another store directory',
			body: publishedNarInfo(appName, 0xbb, {
				deriver: `${appName}.drv`,
				storeDirectory: '/other/store'
			})
		}
	])('refuses $name', async ({ body }) => {
		const anyCause: unknown = expect.any(Error);

		await expect(
			requirePublishedSubjects(subjects, destination, createGithubReporter(), {
				fetch: () => Promise.resolve(new Response(body))
			})
		).rejects.toStrictEqual(
			new CommittedSubjectInvalidError(appPath, anyCause)
		);
	});

	it('refuses a NAR hash that differs from the subject digest', async () => {
		await expect(
			requirePublishedSubjects(subjects, destination, createGithubReporter(), {
				fetch: () =>
					Promise.resolve(new Response(publishedNarInfo(appName, 0xaa)))
			})
		).rejects.toStrictEqual(
			new SubjectNarHashMovedError(appPath, appDigest, 'aa'.repeat(32))
		);
	});
});
