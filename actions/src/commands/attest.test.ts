import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { buildReceiptSchema } from '@cupboard/protocol/build';
import {
	scaiAttributeReportSchema,
	scaiPredicateType
} from '@cupboard/protocol/scai';
import { createGithubReporter } from '@cupboard/reporter';
import { initialiseTracing, stopTracing } from '@cupboard/shared/node-tracing';
import { probeDeadlineMs } from '@cupboard/shared/timeout';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import { currentHttpAttemptTraceHeaders } from '../../../packages/shared/src/fetch-observation.ts';
import { stalledResponse } from '../../../tests/support/stalled-request.ts';
import {
	CacheAccessProbeError,
	MissingInputError,
	ReadPasswordRequiredError,
	ReadUserRequiredError
} from '../errors.ts';
import { parseChecksums } from '../release-install.ts';

import {
	attestAction,
	cacheAccess,
	receiptCandidates,
	renderChecksums,
	resolveAttestInputs
} from './attest.ts';

describe('cacheAccess', () => {
	it('reads nix-cache-info again after the first read hangs past its deadline', async () => {
		const requests: string[] = [];
		const fetcher: typeof fetch = (input, init) => {
			requests.push(input instanceof Request ? input.url : input.toString());
			return requests.length === 1
				? stalledResponse(init?.signal)
				: Promise.resolve(new Response('StoreDir: /nix/store\n'));
		};

		vi.useFakeTimers();
		try {
			const pending = cacheAccess(
				fetcher,
				new URL('https://cache.example.test/t/acme')
			);
			await vi.advanceTimersByTimeAsync(probeDeadlineMs + 5000);

			expect({ access: await pending, requests }).toStrictEqual({
				access: 'public',
				requests: [
					'https://cache.example.test/t/acme/nix-cache-info',
					'https://cache.example.test/t/acme/nix-cache-info'
				]
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('renderChecksums', () => {
	it('renders sha256sum lines and parseChecksums recovers their entries', () => {
		const rendered = renderChecksums([
			{
				storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
				sha256:
					'1111111111111111111111111111111111111111111111111111111111111111'
			},
			{
				storePath: '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime',
				sha256:
					'2222222222222222222222222222222222222222222222222222222222222222'
			}
		]);

		expect(rendered).toBe(
			'1111111111111111111111111111111111111111111111111111111111111111  0123456789abcdfghijklmnpqrsvwxyz-app\n' +
				'2222222222222222222222222222222222222222222222222222222222222222  3123456789abcdfghijklmnpqrsvwxyz-runtime\n'
		);
		expect(Object.fromEntries(parseChecksums(rendered))).toStrictEqual({
			'0123456789abcdfghijklmnpqrsvwxyz-app':
				'1111111111111111111111111111111111111111111111111111111111111111',
			'3123456789abcdfghijklmnpqrsvwxyz-runtime':
				'2222222222222222222222222222222222222222222222222222222222222222'
		});
	});
});

function committedNarInfo(
	storePath: StorePathString,
	digestByte: number,
	options?: { readonly deriver?: string }
): string {
	const deriver =
		options === undefined ? path.basename(`${storePath}.drv`) : options.deriver;
	const hash = NixSha256Hash.fromDigest(
		Buffer.alloc(32, digestByte)
	).toString();

	return [
		`StorePath: ${storePath}`,
		`URL: nar/${path.basename(storePath)}.nar.zst`,
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

const alternateDerivers = [
	{
		name: 'another deriver',
		options: { deriver: '4123456789abcdfghijklmnpqrsvwxyz-older.drv' }
	},
	{ name: 'no deriver', options: {} }
];

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	if (input instanceof URL) {
		return input.href;
	}

	return typeof input === 'string' ? input : input.url;
}

function provenancedSubject(
	storePath: StorePathString,
	digestByte: string,
	verification: 'local' | 'build-store',
	isReproduced = false
) {
	return {
		origin: 'built' as const,
		storePath,
		narHash: digestByte.repeat(32),
		derivation: `${storePath}.drv`,
		buildStore: 'ssh-ng://builder.example',
		verification,
		...(isReproduced && { reproduced: true as const })
	};
}

function copiedSubject(storePath: StorePathString, digestByte: string) {
	return {
		origin: 'copied' as const,
		storePath,
		narHash: digestByte.repeat(32),
		derivation: `${storePath}.drv`,
		signatures: ['cache.example.org-1:c2ln']
	};
}

describe('receiptCandidates', () => {
	const builtPath = storePathSchema.parse(
		'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
	);
	const remotePath = storePathSchema.parse(
		'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
	);
	const substitutedPath = storePathSchema.parse(
		'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-runtime'
	);

	it('retains only named version 2 subjects as built candidates and skips path-only entries', () => {
		const receipt = buildReceiptSchema.parse({
			version: 2,
			paths: [builtPath, substitutedPath],
			subjects: [
				{
					storePath: builtPath,
					narHash: 'aa'.repeat(32),
					derivation: `${builtPath}.drv`,
					attempt: 1,
					attemptId: 'one'
				}
			]
		});
		expect(receiptCandidates(receipt)).toStrictEqual({
			subjects: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
			built: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
			reproduced: [],
			skipped: [substitutedPath]
		});
	});

	it.each([
		{
			name: 'local build',
			subject: provenancedSubject(builtPath, 'aa', 'local')
		},
		{
			name: 'local reproduction',
			subject: provenancedSubject(builtPath, 'aa', 'local', true)
		},
		{
			name: 'store build',
			subject: provenancedSubject(builtPath, 'aa', 'build-store')
		},
		{
			name: 'store-held path',
			subject: {
				origin: 'store-held' as const,
				storePath: builtPath,
				narHash: 'aa'.repeat(32),
				derivation: `${builtPath}.drv`,
				buildStore: 'auto'
			}
		},
		{ name: 'copied path', subject: copiedSubject(builtPath, 'aa') },
		{
			name: 'republished path',
			subject: {
				...copiedSubject(builtPath, 'aa'),
				origin: 'republished' as const,
				metadataSource: 'https://cache.example.test/t/acme'
			}
		}
	])('partitions $name using the recorded receipt identity', ({ subject }) => {
		const receipt = buildReceiptSchema.parse({
			version: 3,
			paths: [builtPath, substitutedPath],
			subjects: [subject]
		});
		const digest = { storePath: builtPath, sha256: 'aa'.repeat(32) };
		const isLocal =
			subject.origin === 'built' && subject.verification === 'local';
		expect(receiptCandidates(receipt)).toStrictEqual({
			subjects: [digest],
			built: isLocal ? [digest] : [],
			reproduced:
				subject.origin === 'built' && subject.reproduced === true
					? [{ ...digest, derivation: subject.derivation }]
					: [],
			skipped: [substitutedPath]
		});
	});

	it.each(['local', 'build-store'] as const)(
		'keeps a remote subject with %s verification out of provenance and reproduction candidates',
		(verification) => {
			const receipt = buildReceiptSchema.parse({
				version: 3,
				paths: [remotePath],
				subjects: [
					{
						...provenancedSubject(remotePath, 'bb', verification, true),
						machine: 'ssh://builder-1'
					}
				]
			});
			expect(receiptCandidates(receipt)).toStrictEqual({
				subjects: [{ storePath: remotePath, sha256: 'bb'.repeat(32) }],
				built: [],
				reproduced: [],
				skipped: []
			});
		}
	);

	it.each([false, true])(
		'keeps copied candidates separate from local builds, copied derivation omitted=%s',
		(omitDerivation) => {
			const subject = copiedSubject(substitutedPath, 'dd');
			const receipt = buildReceiptSchema.parse({
				version: 3,
				paths: [builtPath, substitutedPath],
				subjects: [
					provenancedSubject(builtPath, 'aa', 'local'),
					{ ...subject, ...(omitDerivation && { derivation: undefined }) }
				]
			});
			expect(receiptCandidates(receipt)).toStrictEqual({
				subjects: [
					{ storePath: builtPath, sha256: 'aa'.repeat(32) },
					{ storePath: substitutedPath, sha256: 'dd'.repeat(32) }
				],
				built: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
				reproduced: [],
				skipped: []
			});
		}
	);
});

describe('resolveAttestInputs', () => {
	const receiptFile = '/runner/temp/build-receipt.json';

	it('defaults the checksums file under RUNNER_TEMP when none is given', () => {
		const inputs = resolveAttestInputs(
			{
				receiptFile,
				url: 'https://cache.example.test/t/acme',
				cache: 'builds',
				readUser: 'reader',
				readPassword: 'secret'
			},
			{ RUNNER_TEMP: '/runner/temp' }
		);

		const directory = path.dirname(inputs.checksumsFile);
		expect(directory).toMatch(
			/^\/runner\/temp\/cupboard-attestations\/[\da-f-]{36}$/
		);

		expect(inputs).toStrictEqual({
			receiptFile,
			url: new URL('https://cache.example.test/t/acme'),
			cache: { kind: 'named', name: 'builds' },
			readUser: 'reader',
			readPassword: 'secret',
			checksumsFile: path.join(directory, 'subjects.txt'),
			builtChecksumsFile: path.join(directory, 'built-subjects.txt'),
			predicateFile: path.join(directory, 'attribute-report.json')
		});
	});

	it('reads the read password from the action environment', () => {
		const inputs = resolveAttestInputs(
			{
				receiptFile,
				url: 'https://cache.example.test/t/acme',
				readUser: 'reader',
				checksumsFile: '/runner/temp/subjects.txt'
			},
			{ RUNNER_TEMP: '/runner/temp', READ_PASSWORD: 'secret' }
		);

		expect(inputs).toStrictEqual({
			receiptFile,
			url: new URL('https://cache.example.test/t/acme'),
			cache: { kind: 'default' },
			readUser: 'reader',
			readPassword: 'secret',
			checksumsFile: '/runner/temp/subjects.txt',
			builtChecksumsFile: '/runner/temp/built-subjects.txt',
			predicateFile: '/runner/temp/attribute-report.json'
		});
	});

	it('allocates separate default files for successive attestation steps', () => {
		const options = {
			receiptFile,
			url: 'https://cache.example.test/t/acme'
		};
		const first = resolveAttestInputs(options, { RUNNER_TEMP: '/runner/temp' });
		const second = resolveAttestInputs(options, {
			RUNNER_TEMP: '/runner/temp'
		});
		const filesFor = (inputs: typeof first) => [
			inputs.checksumsFile,
			inputs.builtChecksumsFile,
			inputs.predicateFile
		];

		expect({
			overlappingFiles: filesFor(first).filter((file) =>
				filesFor(second).includes(file)
			)
		}).toStrictEqual({ overlappingFiles: [] });
	});

	it('puts the default predicate file beside an explicit checksums file', () => {
		const inputs = resolveAttestInputs(
			{
				receiptFile,
				url: 'https://cache.example.test/t/acme',
				checksumsFile: '/somewhere/subjects.txt'
			},
			{}
		);

		expect(inputs.predicateFile).toBe('/somewhere/attribute-report.json');
	});

	it('honours an explicit predicate file', () => {
		const inputs = resolveAttestInputs(
			{
				receiptFile,
				url: 'https://cache.example.test/t/acme',
				checksumsFile: '/somewhere/subjects.txt',
				predicateFile: '/elsewhere/origin.json'
			},
			{}
		);

		expect(inputs.predicateFile).toBe('/elsewhere/origin.json');
	});

	it('honours an explicit checksums file', () => {
		const inputs = resolveAttestInputs(
			{
				receiptFile,
				url: 'https://cache.example.test/t/acme',
				checksumsFile: '/somewhere/subjects.txt'
			},
			{ RUNNER_TEMP: '/runner/temp' }
		);

		expect(inputs).toStrictEqual({
			receiptFile,
			url: new URL('https://cache.example.test/t/acme'),
			cache: { kind: 'default' },
			readUser: '',
			readPassword: '',
			checksumsFile: '/somewhere/subjects.txt',
			builtChecksumsFile: '/somewhere/built-subjects.txt',
			predicateFile: '/somewhere/attribute-report.json'
		});
	});

	it('honours an explicit built-checksums file', () => {
		const inputs = resolveAttestInputs(
			{
				receiptFile,
				url: 'https://cache.example.test/t/acme',
				checksumsFile: '/somewhere/subjects.txt',
				builtChecksumsFile: '/elsewhere/built.txt'
			},
			{}
		);

		expect(inputs.builtChecksumsFile).toBe('/elsewhere/built.txt');
	});

	it('requires a build receipt', () => {
		expect(() =>
			resolveAttestInputs(
				{ url: 'https://cache.example.test/t/acme' },
				{ RUNNER_TEMP: '/runner/temp' }
			)
		).toThrow(MissingInputError);
	});

	it('requires the destination URL', () => {
		expect(() =>
			resolveAttestInputs({ receiptFile }, { RUNNER_TEMP: '/runner/temp' })
		).toThrow(MissingInputError);
	});

	it.each([
		{
			name: 'read-user alone',
			readUser: 'reader',
			errorType: ReadPasswordRequiredError
		},
		{
			name: 'read-password alone',
			readPassword: 'secret',
			errorType: ReadUserRequiredError
		}
	])('refuses $name', ({ readUser, readPassword, errorType }) => {
		expect(() =>
			resolveAttestInputs(
				{
					receiptFile,
					url: 'https://cache.example.test/t/acme',
					readUser,
					readPassword
				},
				{ RUNNER_TEMP: '/runner/temp' }
			)
		).toThrow(errorType);
	});

	it('does not require RUNNER_TEMP when the checksums file is explicit', () => {
		const inputs = resolveAttestInputs(
			{
				receiptFile,
				url: 'https://cache.example.test/t/acme',
				checksumsFile: '/explicit/subjects.txt'
			},
			{}
		);

		expect(inputs.checksumsFile).toBe('/explicit/subjects.txt');
	});
});

describe('attestAction receipt candidates', () => {
	const remotePath = storePathSchema.parse(
		'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
	);

	async function receiptFileIn(directory: string): Promise<string> {
		const receiptFile = path.join(directory, 'receipt.json');
		await writeFile(
			receiptFile,
			JSON.stringify({
				version: 3,
				paths: [remotePath],
				subjects: [provenancedSubject(remotePath, 'bb', 'build-store')]
			})
		);

		return receiptFile;
	}

	it('resolves receipt identities without selecting the remote build for SLSA', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
		const receiptFile = await receiptFileIn(directory);
		const checksumsFile = path.join(directory, 'subjects.txt');
		const requests: {
			url: string;
			authorization?: string;
			propagated: boolean;
		}[] = [];
		initialiseTracing();

		try {
			await attestAction(
				{
					receiptFile,
					checksumsFile,
					url: 'https://cache.example.test/t/acme',
					cache: 'builds',
					readUser: 'reader',
					readPassword: 'secret'
				},
				{
					RUNNER_TEMP: directory,
					GITHUB_OUTPUT: path.join(directory, 'output')
				},
				createGithubReporter(),
				{
					fetch: (input, init) => {
						const url = requestUrl(input);
						const origin = new URL(url).origin;
						const traceparent =
							currentHttpAttemptTraceHeaders(origin)?.traceparent ?? '';
						requests.push({
							url: requestUrl(input),
							propagated: /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u.test(
								traceparent
							),
							authorization:
								new Headers(init?.headers).get('authorization') ?? undefined
						});

						return Promise.resolve(
							requestUrl(input).includes('/attestations/')
								? new Response(undefined, { status: StatusCodes.NOT_FOUND })
								: new Response(committedNarInfo(remotePath, 0xbb))
						);
					}
				}
			);

			expect({
				requests,
				checksums: await readFile(checksumsFile, 'utf8'),
				builtChecksums: await readFile(
					path.join(directory, 'built-subjects.txt'),
					'utf8'
				)
			}).toStrictEqual({
				requests: [
					{
						url: 'https://cache.example.test/t/acme/cache/builds/nix-cache-info',
						propagated: true,
						authorization: undefined
					}
				],
				checksums: `${'bb'.repeat(32)}  ${path.basename(remotePath)}\n`,
				builtChecksums: '\n'
			});
		} finally {
			await stopTracing();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('writes no automatic predicate for a newly committed path', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
		const receiptFile = await receiptFileIn(directory);
		const checksumsFile = path.join(directory, 'subjects.txt');
		const predicateFile = path.join(directory, 'attribute-report.json');
		const outputFile = path.join(directory, 'output');
		await writeFile(
			receiptFile,
			JSON.stringify({
				version: 3,
				paths: [remotePath],
				subjects: [provenancedSubject(remotePath, 'bb', 'build-store')],
				uploaded: [remotePath]
			})
		);

		try {
			await attestAction(
				{
					receiptFile,
					checksumsFile,
					url: 'https://cache.example.test/t/acme'
				},
				{
					RUNNER_TEMP: directory,
					GITHUB_OUTPUT: outputFile,
					GITHUB_SERVER_URL: 'https://github.com',
					GITHUB_REPOSITORY: 'acme/app',
					GITHUB_RUN_ID: '123',
					GITHUB_RUN_ATTEMPT: '1'
				},
				createGithubReporter(),
				{
					fetch: (input) =>
						Promise.resolve(
							requestUrl(input).includes('/attestations/')
								? new Response(undefined, { status: StatusCodes.NOT_FOUND })
								: new Response(committedNarInfo(remotePath, 0xbb))
						)
				}
			);

			const outputs = await readFile(outputFile, 'utf8');
			expect({
				predicateWritten: existsSync(predicateFile),
				outputs: outputs
					.split('\n')
					.filter(
						(line) =>
							line.startsWith('predicate-file=') ||
							line.startsWith('predicate-type=')
					)
			}).toStrictEqual({
				predicateWritten: false,
				outputs: ['predicate-file=', 'predicate-type=']
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each(
		[false, true].flatMap((hasAdditionalSubject) =>
			alternateDerivers.map((metadata) => ({
				hasAdditionalSubject,
				...metadata
			}))
		)
	)(
		'preserves the reproduced derivation with $name and additional subject $hasAdditionalSubject',
		async ({ hasAdditionalSubject, options }) => {
			const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
			const additionalPath = storePathSchema.parse(
				'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
			);
			const receiptFile = path.join(directory, 'receipt.json');
			const predicateFile = path.join(directory, 'attribute-report.json');
			const outputFile = path.join(directory, 'output');
			await writeFile(
				receiptFile,
				JSON.stringify({
					version: 3,
					paths: hasAdditionalSubject
						? [remotePath, additionalPath]
						: [remotePath],
					subjects: [
						provenancedSubject(remotePath, 'bb', 'local', true),
						...(hasAdditionalSubject
							? [provenancedSubject(additionalPath, 'cc', 'build-store')]
							: [])
					]
				})
			);

			try {
				await attestAction(
					{
						receiptFile,
						checksumsFile: path.join(directory, 'subjects.txt'),
						url: 'https://cache.example.test/t/acme'
					},
					{ RUNNER_TEMP: directory, GITHUB_OUTPUT: outputFile },
					createGithubReporter(),
					{
						fetch: (input) =>
							Promise.resolve(
								requestUrl(input).includes('/attestations/')
									? new Response(undefined, { status: StatusCodes.NOT_FOUND })
									: new Response(
											requestUrl(input).includes(
												'0123456789abcdfghijklmnpqrsvwxyz'
											)
												? committedNarInfo(additionalPath, 0xcc)
												: committedNarInfo(remotePath, 0xbb, options)
										)
							)
					}
				);

				const outputs = await readFile(outputFile, 'utf8');
				const report: unknown = JSON.parse(
					await readFile(predicateFile, 'utf8')
				);

				expect({
					outputs: outputs
						.split('\n')
						.filter(
							(line) =>
								line.startsWith('predicate-file=') ||
								line.startsWith('predicate-type=')
						),
					report: scaiAttributeReportSchema.parse(report)
				}).toStrictEqual({
					outputs: [
						`predicate-file=${predicateFile}`,
						`predicate-type=${scaiPredicateType}`
					],
					report: {
						attributes: [
							{
								attribute: 'REPRODUCIBLE',
								...(hasAdditionalSubject && {
									target: {
										name: path.basename(remotePath),
										digest: { sha256: 'bb'.repeat(32) }
									}
								}),
								conditions: { derivation: `${remotePath}.drv` }
							}
						]
					}
				});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);

	it('creates no new report or evidence-list requests when reusing previously attested paths', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
		const receiptFile = await receiptFileIn(directory);
		const predicateFile = path.join(directory, 'attribute-report.json');
		const outputFile = path.join(directory, 'output');
		const requests: string[] = [];

		try {
			await attestAction(
				{
					receiptFile,
					checksumsFile: path.join(directory, 'subjects.txt'),
					url: 'https://cache.example.test/t/acme',
					cache: 'builds'
				},
				{ RUNNER_TEMP: directory, GITHUB_OUTPUT: outputFile },
				createGithubReporter(),
				{
					fetch: (input) => {
						requests.push(requestUrl(input));
						return Promise.resolve(
							requestUrl(input).includes('/attestations/')
								? Response.json(
										{
											attestations: Array.from(
												{ length: 1600 },
												(_, index) => ({
													digest: index.toString(16).padStart(64, '0'),
													predicateType: scaiPredicateType,
													size: 2048
												})
											)
										},
										{ headers: { 'content-type': 'application/json' } }
									)
								: new Response(committedNarInfo(remotePath, 0xbb))
						);
					}
				}
			);

			const outputs = await readFile(outputFile, 'utf8');
			expect({
				outputs: outputs
					.split('\n')
					.filter(
						(line) =>
							line.startsWith('predicate-file=') ||
							line.startsWith('predicate-type=')
					),
				predicateWritten: existsSync(predicateFile),
				requests
			}).toStrictEqual({
				outputs: ['predicate-file=', 'predicate-type='],
				predicateWritten: false,
				requests: [
					'https://cache.example.test/t/acme/cache/builds/nix-cache-info'
				]
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		{ access: 'public', status: StatusCodes.OK, selection: {} },
		{
			access: 'private',
			status: StatusCodes.UNAUTHORIZED,
			selection: { cache: 'builds' }
		}
	])(
		'reports a $access destination for $selection',
		async ({ access, selection, status }) => {
			const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
			const receiptFile = await receiptFileIn(directory);
			const outputFile = path.join(directory, 'output');

			try {
				await attestAction(
					{
						receiptFile,
						checksumsFile: path.join(directory, 'subjects.txt'),
						url: 'https://cache.example.test/t/acme',
						...selection
					},
					{ RUNNER_TEMP: directory, GITHUB_OUTPUT: outputFile },
					createGithubReporter(),
					{
						fetch: (input) => {
							const url = requestUrl(input);

							if (url.endsWith('/nix-cache-info')) {
								return Promise.resolve(new Response(undefined, { status }));
							}

							if (url.includes('/attestations/')) {
								return Promise.resolve(
									new Response(undefined, { status: StatusCodes.NOT_FOUND })
								);
							}

							return Promise.resolve(
								new Response(committedNarInfo(remotePath, 0xbb))
							);
						}
					}
				);

				const outputs = await readFile(outputFile, 'utf8');

				expect(
					outputs
						.split('\n')
						.find((line) => line.startsWith('destination-access='))
				).toBe(`destination-access=${access}`);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);

	it('rejects a response that cannot identify the cache access mode', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
		const receiptFile = await receiptFileIn(directory);

		try {
			await expect(
				attestAction(
					{
						receiptFile,
						checksumsFile: path.join(directory, 'subjects.txt'),
						url: 'https://cache.example.test/t/acme'
					},
					{ RUNNER_TEMP: directory },
					createGithubReporter(),
					{
						fetch: () =>
							Promise.resolve(
								new Response(undefined, { status: StatusCodes.NOT_FOUND })
							)
					}
				)
			).rejects.toBeInstanceOf(CacheAccessProbeError);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each(alternateDerivers)(
		'accepts a version 2 receipt with $name without a reproduction report',
		async ({ options }) => {
			const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
			const receiptFile = path.join(directory, 'receipt.json');
			const predicateFile = path.join(directory, 'attribute-report.json');
			const outputFile = path.join(directory, 'output');
			await writeFile(
				receiptFile,
				JSON.stringify({
					version: 2,
					paths: [remotePath],
					subjects: [
						{
							storePath: remotePath,
							narHash: 'bb'.repeat(32),
							derivation: `${remotePath}.drv`,
							attempt: 1,
							attemptId: 'attempt-1'
						}
					]
				})
			);

			try {
				await attestAction(
					{
						receiptFile,
						checksumsFile: path.join(directory, 'subjects.txt'),
						url: 'https://cache.example.test/t/acme'
					},
					{ RUNNER_TEMP: directory, GITHUB_OUTPUT: outputFile },
					createGithubReporter(),
					{
						fetch: (input) =>
							Promise.resolve(
								requestUrl(input).includes('/attestations/')
									? new Response(undefined, { status: StatusCodes.NOT_FOUND })
									: new Response(committedNarInfo(remotePath, 0xbb, options))
							)
					}
				);

				const outputs = await readFile(outputFile, 'utf8');

				expect({
					predicateLine: outputs
						.split('\n')
						.find((line) => line.startsWith('predicate-file=')),
					written: existsSync(predicateFile)
				}).toStrictEqual({ predicateLine: 'predicate-file=', written: false });
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);
});
