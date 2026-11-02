import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import type { BuildSubjectV3Input } from '@cupboard/protocol/build';
import { createGithubReporter } from '@cupboard/reporter';
import { probeDeadlineMs } from '@cupboard/shared/timeout';
import { describe, expect, it, vi } from 'vitest';

import {
	stalledResponse,
	untilOnlyStalledRequestPending
} from '../../../tests/support/stalled-request.ts';
import {
	AttestationSubjectNotAcceptedError,
	CommittedSubjectInvalidError,
	CommittedSubjectUnavailableError,
	MissingInputError,
	SubjectNarHashMovedError
} from '../errors.ts';

import { attestAction } from './attest.ts';
import { attestSignAction } from './attest-sign.ts';

const app = '0123456789abcdfghijklmnpqrsvwxyz-app';
const reused = '3123456789abcdfghijklmnpqrsvwxyz-reused';
const remote = '4123456789abcdfghijklmnpqrsvwxyz-remote';
const appHash = '11'.repeat(32);
const reusedHash = '22'.repeat(32);
const base = 'https://cache.example.test/t/acme';
const cache = `${base}/cache/builds`;

const compactSet = {
	result: {
		storePath: `/nix/store/${remote}`,
		narHash: `sha256:${'1'.repeat(52)}`,
		generation: 0,
		cache: { kind: 'default' },
		cacheGeneration: 1
	},
	digest: 'a'.repeat(64),
	memberCount: 100_000,
	origin: 'build-selection',
	materialisation: 'complete'
};

function built(
	name: string,
	narHash: string
): Extract<BuildSubjectV3Input, { origin: 'built' }> {
	return {
		origin: 'built',
		storePath: `/nix/store/${name}`,
		narHash,
		derivation: `/nix/store/${name}.drv`,
		buildStore: 'auto',
		verification: 'local'
	};
}

function copied(name: string, narHash: string): BuildSubjectV3Input {
	return {
		origin: 'copied',
		storePath: `/nix/store/${name}`,
		narHash,
		signatures: []
	};
}

function receipt(
	subjects: readonly BuildSubjectV3Input[] = [
		built(app, appHash),
		copied(reused, reusedHash)
	]
) {
	return {
		version: 3,
		paths: subjects.map((subject) => subject.storePath),
		subjects
	};
}

function narinfo(
	name: string,
	digest: string,
	directory = '/nix/store'
): string {
	const hash = NixSha256Hash.fromDigest(Buffer.from(digest, 'hex')).toString();
	return [
		`StorePath: ${directory}/${name}`,
		'URL: nar/test.nar.zst',
		'Compression: zstd',
		`FileHash: ${hash}`,
		'FileSize: 1',
		`NarHash: ${hash}`,
		'NarSize: 1',
		'References: ',
		''
	].join('\n');
}

function defaultResponse(url: string): Response {
	return url.endsWith('nix-cache-info')
		? new Response()
		: new Response(narinfo(app, appHash));
}

async function fixture(document: unknown = receipt()) {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-destination-'));
	const receiptFile = path.join(directory, 'receipt.json');
	const checksumsFile = path.join(directory, 'subjects.txt');
	const builtChecksumsFile = path.join(directory, 'built-subjects.txt');
	const requests: { url: string; authorization: string | undefined }[] = [];
	const signed: unknown[] = [];
	const outputs: Record<string, string> = {};
	await writeFile(receiptFile, JSON.stringify(document));
	const options = {
		url: base,
		cache: 'builds',
		receiptFile,
		checksumsFile,
		builtChecksumsFile
	};
	const environment = {
		RUNNER_TEMP: directory,
		GITHUB_OUTPUT: path.join(directory, 'output')
	};
	let responseFor = defaultResponse;
	const fetcher: typeof fetch = (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		requests.push({
			url,
			authorization:
				new Headers(init?.headers).get('authorization') ?? undefined
		});
		return Promise.resolve(responseFor(url));
	};
	return {
		directory,
		receiptFile,
		checksumsFile,
		builtChecksumsFile,
		requests,
		signed,
		outputs,
		respond: (body: typeof responseFor) => {
			responseFor = body;
		},
		resolve: () =>
			attestAction(options, environment, createGithubReporter(), {
				fetch: fetcher
			}),
		sign: (
			overrides: Parameters<typeof attestSignAction>[0] = {},
			fetchOverride = fetcher,
			signingEnvironment: Readonly<Record<string, string>> = {}
		) =>
			attestSignAction(
				{
					...options,
					githubToken: 'token',
					destinationAccess: 'public',
					...overrides
				},
				createGithubReporter(),
				{
					fetch: fetchOverride,
					environment: signingEnvironment,
					setOutput: (name, value) => {
						outputs[name] = value;
					},
					provenanceStatement: () =>
						Promise.resolve({
							predicateType: 'https://slsa.dev/provenance/v1',
							predicate: {}
						}),
					signerFor:
						({ subjects }) =>
						(statement) => {
							signed.push({ subjects, statement });
							return Promise.resolve({
								bundle: '{}',
								evidence: { tlogEntryCount: 1, timestampCount: 0 }
							});
						}
				}
			),
		close: () => rm(directory, { recursive: true, force: true })
	};
}

function byRequestUrl(
	left: { readonly url: string },
	right: { readonly url: string }
): number {
	return left.url.localeCompare(right.url);
}

function urls(names: readonly string[]) {
	return names.map((name) => ({
		url: `${cache}/${name.slice(0, 32)}.narinfo`,
		authorization: undefined
	}));
}

describe('destination validation after statement selection', () => {
	it('does not turn compact V4 publication sets into candidate or signing subjects', async () => {
		const test = await fixture({
			version: 4,
			paths: [],
			subjects: [],
			publicationSets: [compactSet]
		});
		try {
			await test.resolve();
			const candidates = await readFile(test.checksumsFile, 'utf8');
			test.requests.length = 0;
			test.respond(() => new Response(undefined, { status: 404 }));
			await test.sign({
				bundlesFile: path.join(test.directory, 'bundles.txt')
			});
			expect({
				candidates,
				requests: test.requests,
				signed: test.signed,
				bundles: test.outputs['bundles-file'],
				signedChecksums: await readFile(
					test.outputs['checksums-file'] ?? '',
					'utf8'
				)
			}).toStrictEqual({
				candidates: '\n',
				requests: [],
				signed: [],
				bundles: '',
				signedChecksums: ''
			});
		} finally {
			await test.close();
		}
	});

	it('resolves all receipt candidates without reading their destination narinfos', async () => {
		const test = await fixture();
		try {
			test.respond((url) =>
				url.endsWith('nix-cache-info')
					? new Response()
					: new Response(undefined, { status: 404 })
			);
			await test.resolve();
			expect({
				requests: test.requests.toSorted(byRequestUrl),
				candidates: await readFile(test.checksumsFile, 'utf8'),
				built: await readFile(test.builtChecksumsFile, 'utf8')
			}).toStrictEqual({
				requests: [
					{ url: `${cache}/nix-cache-info`, authorization: undefined }
				],
				candidates: `${appHash}  ${app}\n${reusedHash}  ${reused}\n`,
				built: `${appHash}  ${app}\n`
			});
		} finally {
			await test.close();
		}
	});

	it('checks only runner-local provenance subjects, ignoring unrelated missing subjects', async () => {
		const document = receipt([
			built(app, appHash),
			copied(reused, reusedHash),
			{ ...built(remote, reusedHash), machine: 'ssh://builder' }
		]);
		const test = await fixture(document);
		try {
			await test.resolve();
			test.requests.length = 0;
			await test.sign();
			expect({
				requests: test.requests.toSorted(byRequestUrl),
				signed: test.signed.length,
				checksums: await readFile(test.outputs['checksums-file'] ?? '', 'utf8')
			}).toStrictEqual({
				requests: urls([app]),
				signed: 1,
				checksums: `${appHash}  ${app}\n`
			});
		} finally {
			await test.close();
		}
	});

	it.each([
		copied(remote, reusedHash),
		{ ...built(remote, reusedHash), verification: 'build-store' as const },
		{ ...built(remote, reusedHash), machine: 'ssh://builder' },
		{
			origin: 'store-held' as const,
			storePath: `/nix/store/${remote}`,
			narHash: reusedHash,
			buildStore: 'auto'
		},
		{
			origin: 'republished' as const,
			storePath: `/nix/store/${remote}`,
			narHash: reusedHash,
			signatures: [],
			metadataSource: base
		}
	])(
		'does not read unrelated $origin subject metadata for default provenance',
		async (unused) => {
			const test = await fixture(receipt([built(app, appHash), unused]));
			try {
				await test.resolve();
				test.requests.length = 0;
				await test.sign();
				expect({
					requests: test.requests.toSorted(byRequestUrl),
					signed: test.signed.length
				}).toStrictEqual({ requests: urls([app]), signed: 1 });
			} finally {
				await test.close();
			}
		}
	);

	it.each([
		{
			name: 'missing',
			response: () => new Response(undefined, { status: 404 }),
			error: CommittedSubjectUnavailableError
		},
		{
			name: 'unauthorised',
			response: () => new Response(undefined, { status: 401 }),
			error: CommittedSubjectUnavailableError
		},
		{
			name: 'moved',
			response: () => new Response(narinfo(app, reusedHash)),
			error: SubjectNarHashMovedError
		},
		{
			name: 'malformed',
			response: () => new Response('not a narinfo'),
			error: CommittedSubjectInvalidError
		},
		{
			name: 'another path',
			response: () => new Response(narinfo(reused, appHash)),
			error: CommittedSubjectInvalidError
		},
		{
			name: 'another store directory',
			response: () => new Response(narinfo(app, appHash, '/other/store')),
			error: CommittedSubjectInvalidError
		}
	])(
		'rejects $name selected provenance before signing',
		async ({ response, error }) => {
			const test = await fixture();
			try {
				await test.resolve();
				test.requests.length = 0;
				test.respond(response);
				await expect(test.sign()).rejects.toBeInstanceOf(error);
				expect({
					requests: test.requests.toSorted(byRequestUrl),
					signed: test.signed
				}).toStrictEqual({
					requests: urls([app]),
					signed: []
				});
			} finally {
				await test.close();
			}
		}
	);

	it('requires destination context for custom signing', async () => {
		const test = await fixture();
		try {
			await test.resolve();
			test.requests.length = 0;
			await expect(test.sign({ url: undefined })).rejects.toBeInstanceOf(
				MissingInputError
			);
			expect({
				requests: test.requests.toSorted(byRequestUrl),
				signed: test.signed
			}).toStrictEqual({
				requests: [],
				signed: []
			});
		} finally {
			await test.close();
		}
	});

	it.each([false, true])(
		'validates every custom subject before signing, moved=%s',
		async (moved) => {
			const test = await fixture();
			try {
				await test.resolve();
				test.requests.length = 0;
				const predicateFile = path.join(test.directory, 'custom.json');
				await writeFile(predicateFile, '{}');
				test.respond(
					(url) =>
						new Response(
							url.includes(reused.slice(0, 32))
								? narinfo(reused, moved ? appHash : reusedHash)
								: narinfo(app, appHash)
						)
				);
				const pending = test.sign({
					receiptFile: '',
					predicateFile,
					predicateType: 'https://example.test/custom'
				});
				if (moved) {
					await expect(pending).rejects.toBeInstanceOf(
						SubjectNarHashMovedError
					);
				} else {
					await pending;
				}
				expect({
					requests: test.requests.toSorted(byRequestUrl),
					signed: test.signed.length
				}).toStrictEqual({
					requests: urls([app, reused]),
					signed: moved ? 0 : 2
				});
			} finally {
				await test.close();
			}
		}
	);

	it.each(
		[3, 4].flatMap((version) =>
			[false, true].map((missing) => ({ version, missing }))
		)
	)(
		'retains and validates V$version generated reproduction digest aliases, missing=$missing',
		async ({ version, missing }) => {
			const test = await fixture({
				...receipt([
					{ ...built(app, appHash), reproduced: true },
					copied(reused, appHash)
				]),
				version,
				...(version === 4 && { publicationSets: [compactSet] })
			});
			try {
				await test.resolve();
				test.requests.length = 0;
				test.respond((url) => {
					const isAlias = url.includes(reused.slice(0, 32));
					if (missing && isAlias) {
						return new Response(undefined, { status: 404 });
					}
					return new Response(narinfo(isAlias ? reused : app, appHash));
				});
				const pending = test.sign();
				if (missing) {
					await expect(pending).rejects.toBeInstanceOf(
						CommittedSubjectUnavailableError
					);
				} else {
					await pending;
				}
				expect({
					requests: test.requests.toSorted(byRequestUrl),
					signed: test.signed.length,
					checksums: missing
						? ''
						: await readFile(test.outputs['checksums-file'] ?? '', 'utf8')
				}).toStrictEqual({
					requests: urls([app, reused]),
					signed: missing ? 0 : 2,
					checksums: missing
						? ''
						: `${appHash}  ${app}\n${appHash}  ${reused}\n`
				});
			} finally {
				await test.close();
			}
		}
	);

	it.each([
		{ subjects: [] },
		{ subjects: [copied(reused, reusedHash)] },
		{
			subjects: [
				{ ...built(remote, reusedHash), verification: 'build-store' as const }
			]
		}
	])(
		'succeeds without signing or narinfo reads when no statements have subjects: %j',
		async ({ subjects }) => {
			const test = await fixture(receipt(subjects));
			try {
				await test.resolve();
				test.requests.length = 0;
				test.respond(() => new Response(undefined, { status: 404 }));
				await test.sign({
					bundlesFile: path.join(test.directory, 'bundles.txt')
				});
				expect({
					requests: test.requests.toSorted(byRequestUrl),
					signed: test.signed,
					bundles: test.outputs['bundles-file'],
					checksums: await readFile(
						test.outputs['checksums-file'] ?? '',
						'utf8'
					)
				}).toStrictEqual({
					requests: [],
					signed: [],
					bundles: '',
					checksums: ''
				});
			} finally {
				await test.close();
			}
		}
	);

	it('uses Basic read credentials only on selected destination reads', async () => {
		const test = await fixture();
		try {
			await test.resolve();
			test.requests.length = 0;
			await test.sign({ readUser: 'reader', readPassword: 'secret' });
			expect(test.requests.toSorted(byRequestUrl)).toStrictEqual([
				{
					...urls([app])[0],
					authorization: `Basic ${Buffer.from('reader:secret').toString('base64')}`
				}
			]);
		} finally {
			await test.close();
		}
	});

	it('uses renewable wrapper credentials for selected metadata only', async () => {
		const test = await fixture(
			receipt([built(app, appHash), built(reused, reusedHash)])
		);
		const netrc = path.join(test.directory, 'netrc');
		try {
			await test.resolve();
			test.requests.length = 0;
			await writeFile(
				netrc,
				'machine cache.example.test login cupboard-oidc password renewed\n'
			);
			vi.stubEnv('NIX_CONFIG', `netrc-file = ${netrc}`);
			test.respond((url) => {
				const isReused = url.includes(reused.slice(0, 32));
				return new Response(
					narinfo(isReused ? reused : app, isReused ? reusedHash : appHash)
				);
			});
			await test.sign();
			expect(test.requests.toSorted(byRequestUrl)).toStrictEqual(
				urls([app, reused]).map((request) => ({
					...request,
					authorization: `Basic ${Buffer.from('cupboard-oidc:renewed').toString('base64')}`
				}))
			);
		} finally {
			vi.unstubAllEnvs();
			await test.close();
		}
	});

	it('reads a Basic password from the signing environment without putting it in options', async () => {
		const test = await fixture();
		try {
			await test.resolve();
			test.requests.length = 0;
			await test.sign({ readUser: 'reader' }, undefined, {
				READ_PASSWORD: 'environment-secret'
			});
			expect(test.requests.toSorted(byRequestUrl)).toStrictEqual([
				{
					...urls([app])[0],
					authorization: `Basic ${Buffer.from('reader:environment-secret').toString('base64')}`
				}
			]);
		} finally {
			await test.close();
		}
	});

	it('uses selected narinfo identity for a legacy checksum file without a store directory', async () => {
		const test = await fixture(receipt([built(app, appHash)]));
		try {
			await test.resolve();
			test.requests.length = 0;
			test.respond(() => new Response(narinfo(app, appHash, '/other/store')));
			await test.sign({ receiptFile: '' });
			expect({
				requests: test.requests.toSorted(byRequestUrl),
				signed: test.signed.length
			}).toStrictEqual({ requests: urls([app]), signed: 1 });
		} finally {
			await test.close();
		}
	});

	it.each([
		'candidate hash',
		'unknown candidate',
		'duplicate candidate',
		'built attribution'
	])('rejects inconsistent %s before destination reads', async (kind) => {
		const test = await fixture();
		try {
			await test.resolve();
			test.requests.length = 0;
			if (kind === 'built attribution') {
				await writeFile(test.builtChecksumsFile, `${reusedHash}  ${reused}\n`);
			} else {
				const checksums =
					kind === 'candidate hash'
						? `${reusedHash}  ${app}\n`
						: kind === 'unknown candidate'
							? `${appHash}  ${app}\n${reusedHash}  ${remote}\n`
							: `${appHash}  ${app}\n${appHash}  ${app}\n`;
				await writeFile(test.checksumsFile, checksums);
			}
			await expect(test.sign()).rejects.toBeInstanceOf(
				AttestationSubjectNotAcceptedError
			);
			expect({
				requests: test.requests.toSorted(byRequestUrl),
				signed: test.signed
			}).toStrictEqual({
				requests: [],
				signed: []
			});
		} finally {
			await test.close();
		}
	});

	it.each([
		'duplicate paths',
		'duplicate subject',
		'conflicting subject hash',
		'invalid hash'
	])('rejects %s in a receipt without destination reads', async (kind) => {
		const subject = built(app, appHash);
		const paths = [`/nix/store/${app}`];
		const subjects =
			kind === 'invalid hash'
				? [{ ...subject, narHash: 'invalid' }]
				: kind === 'duplicate subject'
					? [subject, subject]
					: kind === 'conflicting subject hash'
						? [subject, { ...subject, narHash: reusedHash }]
						: [subject];
		const test = await fixture({
			version: 3,
			paths: kind === 'duplicate paths' ? [...paths, ...paths] : paths,
			subjects
		});
		try {
			await expect(test.resolve()).rejects.toThrow();
			expect(test.requests.toSorted(byRequestUrl)).toStrictEqual([]);
		} finally {
			await test.close();
		}
	});

	it('retries a selected narinfo after its read deadline', async () => {
		const test = await fixture();
		try {
			await test.resolve();
			test.requests.length = 0;
			let attempts = 0;
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const pending = test.sign({}, (_input, init) =>
				++attempts === 1
					? stalledResponse(init?.signal)
					: Promise.resolve(new Response(narinfo(app, appHash)))
			);
			const settled = expect(pending).resolves.toBeUndefined();
			await untilOnlyStalledRequestPending(() => attempts === 1);
			await vi.advanceTimersByTimeAsync(probeDeadlineMs + 5000);
			await settled;
			expect({ attempts, signed: test.signed.length }).toStrictEqual({
				attempts: 2,
				signed: 1
			});
		} finally {
			vi.useRealTimers();
			await test.close();
		}
	});

	it.each([2, 3])(
		'rejects inconsistent version %s receipt identities without destination reads',
		async (version) => {
			const subject =
				version === 3
					? built(app, appHash)
					: {
							storePath: `/nix/store/${app}`,
							narHash: appHash,
							derivation: `/nix/store/${app}.drv`,
							attempt: 1,
							attemptId: 'one'
						};
			const test = await fixture({ version, paths: [], subjects: [subject] });
			try {
				await expect(test.resolve()).rejects.toBeInstanceOf(
					AttestationSubjectNotAcceptedError
				);
				expect(test.requests.toSorted(byRequestUrl)).toStrictEqual([]);
			} finally {
				await test.close();
			}
		}
	);

	it.each([
		{
			state: 'present',
			response: () => new Response(narinfo(app, appHash)),
			error: undefined
		},
		{
			state: 'missing',
			response: () => new Response(undefined, { status: 404 }),
			error: CommittedSubjectUnavailableError
		},
		{
			state: 'moved',
			response: () => new Response(narinfo(app, reusedHash)),
			error: SubjectNarHashMovedError
		}
	])(
		'validates $state v2 subjects before signing, without reading path-only legacy extras',
		async ({ response, error }) => {
			const test = await fixture({
				version: 2,
				paths: [`/nix/store/${app}`, `/nix/store/${reused}`],
				subjects: [
					{
						storePath: `/nix/store/${app}`,
						narHash: appHash,
						derivation: `/nix/store/${app}.drv`,
						attempt: 1,
						attemptId: 'one'
					}
				]
			});
			try {
				await test.resolve();
				test.requests.length = 0;
				test.respond(response);
				const pending = test.sign();
				if (error === undefined) {
					await pending;
				} else {
					await expect(pending).rejects.toBeInstanceOf(error);
				}
				expect({
					requests: test.requests.toSorted(byRequestUrl),
					candidates: await readFile(test.checksumsFile, 'utf8'),
					signed: test.signed.length
				}).toStrictEqual({
					requests: urls([app]),
					candidates: `${appHash}  ${app}\n`,
					signed: error === undefined ? 1 : 0
				});
			} finally {
				await test.close();
			}
		}
	);
});
