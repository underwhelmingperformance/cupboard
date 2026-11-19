import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	truncate,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { maxTransientRetries } from '@cupboard/shared/retry';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { expect, it, vi } from 'vitest';

import { derivationArchiveName } from './derivation-closure.ts';
import {
	DerivationClosureImportError,
	MissingDerivationTicketError,
	PlanArchiveConnectionError
} from './errors.ts';
import {
	encryptedDerivationArchiveName,
	exportEncryptedDerivations,
	importEncryptedDerivations,
	PlanArchiveExchangeError
} from './plan-archive.ts';

const ticket = 'v1.' + '1'.repeat(64);
const access = {
	url: new URL('https://cupboard.example.workers.dev/t/acme/cache/ci'),
	audience: 'custom-workflow-audience',
	cache: { kind: 'default' }
} as const;
const getToken = () => Promise.resolve('job-token');

it.each([
	{
		body: JSON.stringify({
			error: 'invalid_grant',
			problem: 'invalid-plan-archive-ticket',
			error_description: 'sensitive detail'
		}),
		problem: 'invalid-plan-archive-ticket'
	},
	{
		body: JSON.stringify({
			error: 'invalid_grant',
			problem: 'plan-archive-issuer-unsupported'
		}),
		problem: 'plan-archive-issuer-unsupported'
	},
	{ body: 'sensitive detail', problem: undefined }
])(
	'preserves the OAuth problem on a refused redemption (%s)',
	async ({ body, problem }) => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-redemption-')
		);
		try {
			const result = importEncryptedDerivations(
				path.join(directory, 'download.age'),
				[],
				directory,
				access,
				ticket,
				{
					getToken,
					fetch: () => Promise.resolve(new Response(body, { status: 400 })),
					sleep: () => {
						throw new Error('A grant refusal must not be retried');
					}
				}
			);
			await expect(result).rejects.toThrow(PlanArchiveExchangeError);
			await expect(result).rejects.toStrictEqual(
				new PlanArchiveExchangeError(400, problem)
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
);

it.each(['issue', 'redeem'] as const)(
	'retries transient responses and connection failures during %s',
	async (operation) => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-exchange-'));
		const fetcher = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(
				new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
			)
			.mockResolvedValueOnce(new Response(undefined, { status: 503 }))
			.mockResolvedValueOnce(
				new Response(undefined, {
					status: 429,
					headers: { 'Retry-After': '60' }
				})
			)
			.mockResolvedValueOnce(
				Response.json(
					{ error: 'invalid_grant', problem: 'subject-token-untrusted' },
					{ status: 400 }
				)
			);
		const sleep = vi
			.fn<(_delay: number) => Promise<void>>()
			.mockResolvedValue(undefined);
		let sequence = 0;
		const tokens = () => Promise.resolve('token-' + String(++sequence));
		const dependencies = { fetch: fetcher, getToken: tokens, sleep };
		try {
			const result =
				operation === 'issue'
					? exportEncryptedDerivations([], directory, access, dependencies)
					: importEncryptedDerivations(
							path.join(directory, 'download.age'),
							[],
							directory,
							access,
							ticket,
							dependencies
						);
			await expect(result).rejects.toStrictEqual(
				new PlanArchiveExchangeError(400, 'subject-token-untrusted')
			);
			expect(
				fetcher.mock.calls.map(([, init]) =>
					init?.body instanceof URLSearchParams
						? init.body.get('subject_token')
						: undefined
				)
			).toStrictEqual(['token-1', 'token-2', 'token-3', 'token-4']);
			expect(sleep.mock.calls.map(([delay]) => delay)).toStrictEqual([
				expect.any(Number),
				expect.any(Number),
				60_000
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
);

it.each([
	{
		status: 429,
		header: '60',
		delay: 60_000,
		attempts: maxTransientRetries + 1
	},
	{ status: 503, header: '120', delay: 120_000, attempts: 1 },
	{ status: 502, header: '0', delay: 0, attempts: maxTransientRetries + 1 },
	{
		status: 429,
		header: 'Thu, 01 Jan 1970 00:00:00 GMT',
		delay: 0,
		attempts: maxTransientRetries + 1
	},
	{ status: 500, header: '0', delay: 0, attempts: 1 }
])(
	'classifies HTTP $status and Retry-After $header',
	async ({ status, header, delay, attempts }) => {
		const fetcher = vi.fn<typeof fetch>(() =>
			Promise.resolve(
				Response.json(
					{ error: 'server_error', problem: 'test-refusal' },
					{ status, headers: { 'Retry-After': header } }
				)
			)
		);
		const sleep = vi
			.fn<(_delay: number) => Promise<void>>()
			.mockResolvedValue(undefined);
		const result = exportEncryptedDerivations([], tmpdir(), access, {
			getToken,
			fetch: fetcher,
			sleep,
			random: () => 0.5
		});
		await expect(result).rejects.toStrictEqual(
			new PlanArchiveExchangeError(status, 'test-refusal', delay)
		);
		expect(fetcher).toHaveBeenCalledTimes(attempts);
		expect(sleep.mock.calls.map(([delay]) => delay)).toStrictEqual(
			attempts === 1
				? []
				: delay === 0
					? [125, 250, 500, 1000]
					: Array.from({ length: maxTransientRetries }, () => delay)
		);
	}
);

it('preserves a connection failure after exhausting the exchange attempts', async () => {
	const cause = new TypeError('fetch failed', {
		cause: { code: 'ECONNRESET' }
	});
	const fetcher = vi.fn<typeof fetch>().mockRejectedValue(cause);
	const result = exportEncryptedDerivations([], tmpdir(), access, {
		getToken,
		fetch: fetcher,
		sleep: () => Promise.resolve()
	});
	await expect(result).rejects.toStrictEqual(
		new PlanArchiveConnectionError(cause)
	);
	expect(fetcher).toHaveBeenCalledTimes(maxTransientRetries + 1);
});

it('reports a missing ticket before requesting a token', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-redemption-'));
	const token = vi.fn(getToken);
	try {
		await expect(
			importEncryptedDerivations(
				path.join(directory, 'download.age'),
				[],
				directory,
				access,
				undefined,
				{ getToken: token }
			)
		).rejects.toThrow(MissingDerivationTicketError);
		expect(token).not.toHaveBeenCalled();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it.each([false, true])(
	'finishes age decryption before importing the closure (truncated: %s)',
	async (truncated) => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'cupboard-plan-archive-')
		);
		const privateSource = Buffer.from(
			'private-evaluation-product\n'.repeat(10_000)
		);
		const identity = await generateX25519Identity();
		const recipient = await identityToRecipient(identity);
		const requests: string[][] = [];
		const requestToken = vi.fn(getToken);
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const body = new URLSearchParams(await request.text());
			requests.push([
				request.url,
				body.get('cache') ?? '',
				body.get('ticket') ?? 'issue'
			]);
			return Response.json(
				body.has('ticket') ? { identity } : { ticket, recipient }
			);
		};
		const imported: Buffer[] = [];
		const mask = vi.fn();
		try {
			const result = await exportEncryptedDerivations([], directory, access, {
				fetch: fetcher,
				getToken: requestToken,
				exportClosure: async (_roots, staging) => {
					await mkdir(staging);
					const archive = path.join(staging, derivationArchiveName);
					await writeFile(archive, privateSource);
					return {
						archive,
						archiveBytes: privateSource.length,
						paths: 1,
						checkMs: 0,
						copyMs: 0,
						packMs: 0
					};
				}
			});
			const ciphertext = await readFile(result.archive);
			expect(await readdir(path.dirname(result.archive))).toStrictEqual([
				encryptedDerivationArchiveName
			]);
			expect(ciphertext.subarray(0, 21).toString()).toBe(
				'age-encryption.org/v1'
			);
			expect(ciphertext.includes(privateSource.subarray(0, 24))).toBe(false);
			if (truncated) {
				await truncate(result.archive, ciphertext.length - 1);
			}
			const staging = path.join(directory, 'cohort');
			const opening = importEncryptedDerivations(
				result.archive,
				[],
				staging,
				access,
				result.ticket,
				{
					fetch: fetcher,
					getToken: requestToken,
					mask,
					importClosure: async (archive) => {
						imported.push(await readFile(archive));
						return { archivePaths: 1, unpackMs: 0, verifyMs: 0, copyMs: 0 };
					}
				}
			);
			if (truncated) {
				await expect(opening).rejects.toThrow(DerivationClosureImportError);
			} else {
				await opening;
			}
			expect(mask.mock.calls).toStrictEqual([[identity]]);
			expect(imported).toStrictEqual(truncated ? [] : [privateSource]);
			expect(await readdir(staging)).toStrictEqual([]);
			const tenant = 'https://cupboard.example.workers.dev/t/acme';
			expect(requestToken.mock.calls).toStrictEqual([[tenant], [tenant]]);
			const endpoint = tenant + '/token';
			expect(requests).toStrictEqual([
				[endpoint, 'ci', 'issue'],
				[endpoint, 'ci', ticket]
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
);
