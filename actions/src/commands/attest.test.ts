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
import { buildOriginPredicateType } from '@cupboard/protocol/build-origin';
import { createGithubReporter } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	CacheAccessProbeError,
	CommittedSubjectInvalidError,
	CommittedSubjectUnavailableError,
	MissingInputError,
	ReadPasswordRequiredError,
	ReadUserRequiredError,
	SubjectDeriverMovedError,
	SubjectNarHashMovedError,
	SubjectNotHeldError
} from '../errors.ts';
import { parseChecksums } from '../release-install.ts';

import {
	attestAction,
	attestationSubjects,
	buildOriginPredicateFor,
	provenancedSubjects,
	renderChecksums,
	resolveAttestInputs,
	type SelectedPathInfos
} from './attest.ts';

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

function attestPathInfo(storePath: StorePathString, digestByte: number) {
	return {
		storePath,
		deriver: `${storePath}.drv`,
		narHash: NixSha256Hash.fromDigest(Buffer.alloc(32, digestByte)),
		narSize: 1,
		references: [],
		signatures: [],
		ultimate: false
	};
}

function committedNarInfo(
	storePath: StorePathString,
	digestByte: number,
	deriver = path.basename(`${storePath}.drv`)
): string {
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
		`Deriver: ${deriver}`,
		''
	].join('\n');
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	if (input instanceof URL) {
		return input.href;
	}

	return typeof input === 'string' ? input : input.url;
}

describe('attestationSubjects', () => {
	const builtPath = storePathSchema.parse(
		'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
	);
	const substitutedPath = storePathSchema.parse(
		'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
	);

	it('returns only paths listed in the current build receipt', () => {
		const partitioned = attestationSubjects(
			[attestPathInfo(builtPath, 0xaa), attestPathInfo(substitutedPath, 0xbb)],
			{
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
			}
		);

		expect(partitioned).toStrictEqual({
			subjects: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
			built: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
			skipped: [substitutedPath]
		});
	});

	it('rejects a NAR hash that changed after the receipt was written', () => {
		expect(() =>
			attestationSubjects([attestPathInfo(builtPath, 0xbb)], {
				version: 2,
				paths: [builtPath],
				subjects: [
					{
						storePath: builtPath,
						narHash: 'aa'.repeat(32),
						derivation: `${builtPath}.drv`,
						attempt: 1,
						attemptId: 'one'
					}
				]
			})
		).toThrow(/NAR hash/u);
	});
});

function provenancedSubject(
	storePath: StorePathString,
	digestByte: string,
	verification: 'local' | 'build-store'
) {
	return {
		origin: 'built' as const,
		storePath,
		narHash: digestByte.repeat(32),
		derivation: `${storePath}.drv`,
		buildStore: 'ssh-ng://builder.example',
		verification
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

function acceptedDigest(storePath: StorePathString, sha256: string) {
	return { storePath, sha256 };
}

const heldNowhere: SelectedPathInfos = new Map();

describe('provenancedSubjects', () => {
	const builtPath = storePathSchema.parse(
		'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
	);
	const remotePath = storePathSchema.parse(
		'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
	);
	const substitutedPath = storePathSchema.parse(
		'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-runtime'
	);

	const realisedHere = [
		{ name: 'a local build', verification: 'local' as const },
		{
			name: 'a build the selected store realised',
			verification: 'build-store' as const
		}
	];

	const holdsBuiltPath: SelectedPathInfos = new Map([
		[builtPath, attestPathInfo(builtPath, 0xaa)]
	]);

	it.each(realisedHere)(
		'attests $name whose metadata is committed at the destination',
		({ verification }) => {
			expect(
				provenancedSubjects(
					{
						version: 3,
						paths: [builtPath, substitutedPath],
						subjects: [provenancedSubject(builtPath, 'aa', verification)]
					},
					holdsBuiltPath
				)
			).toStrictEqual({
				subjects: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
				built: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
				skipped: [substitutedPath]
			});
		}
	);

	it.each(realisedHere)(
		'refuses $name absent from the committed destination',
		({ verification }) => {
			let failure: unknown;

			try {
				provenancedSubjects(
					{
						version: 3,
						paths: [builtPath],
						subjects: [provenancedSubject(builtPath, 'aa', verification)]
					},
					heldNowhere
				);
			} catch (error) {
				failure = error;
			}

			expect(failure).toBeInstanceOf(SubjectNotHeldError);

			if (failure instanceof SubjectNotHeldError) {
				expect({
					storePath: failure.storePath,
					origin: failure.origin
				}).toStrictEqual({ storePath: builtPath, origin: 'built' });
			}
		}
	);

	it.each([
		{
			name: 'a NAR hash that moved since the receipt was written',
			digestByte: 0xcc,
			deriver: `${builtPath}.drv`,
			expected: SubjectNarHashMovedError
		},
		{
			name: 'a deriver that moved since the receipt was written',
			digestByte: 0xaa,
			deriver: `${remotePath}.drv`,
			expected: SubjectDeriverMovedError
		}
	])(
		'refuses attestation when destination metadata contains $name',
		({ digestByte, deriver, expected }) => {
			const held: SelectedPathInfos = new Map([
				[
					builtPath,
					{
						storePath: builtPath,
						narHash: NixSha256Hash.fromDigest(Buffer.alloc(32, digestByte)),
						narSize: 1,
						references: [],
						deriver,
						signatures: [],
						ultimate: true
					}
				]
			]);

			expect(() =>
				provenancedSubjects(
					{
						version: 3,
						paths: [builtPath],
						subjects: [provenancedSubject(builtPath, 'aa', 'local')]
					},
					held
				)
			).toThrow(expected);
		}
	);

	it('refuses a build-store subject absent from the explicitly selected store', () => {
		expect(() =>
			provenancedSubjects(
				{
					version: 3,
					paths: [remotePath],
					subjects: [provenancedSubject(remotePath, 'bb', 'build-store')]
				},
				heldNowhere
			)
		).toThrow(SubjectNotHeldError);
	});

	it('accepts a build-store subject present in the selected destination cache', () => {
		const heldRemotely: SelectedPathInfos = new Map([
			[remotePath, attestPathInfo(remotePath, 0xbb)]
		]);

		expect(
			provenancedSubjects(
				{
					version: 3,
					paths: [remotePath],
					subjects: [provenancedSubject(remotePath, 'bb', 'build-store')]
				},
				heldRemotely
			)
		).toStrictEqual({
			subjects: [{ storePath: remotePath, sha256: 'bb'.repeat(32) }],
			built: [{ storePath: remotePath, sha256: 'bb'.repeat(32) }],
			skipped: []
		});
	});

	it('accepts a subject whose receipt records a remote builder', () => {
		const holdsRemotePath: SelectedPathInfos = new Map([
			[remotePath, attestPathInfo(remotePath, 0xbb)]
		]);
		const receipt = {
			version: 3 as const,
			paths: [remotePath],
			subjects: [
				{
					origin: 'built' as const,
					storePath: remotePath,
					narHash: 'bb'.repeat(32),
					derivation: `${remotePath}.drv`,
					buildStore: 'auto',
					machine: 'ssh://builder-1',
					verification: 'build-store' as const
				}
			]
		};

		expect(provenancedSubjects(receipt, holdsRemotePath)).toStrictEqual({
			subjects: [{ storePath: remotePath, sha256: 'bb'.repeat(32) }],
			built: [{ storePath: remotePath, sha256: 'bb'.repeat(32) }],
			skipped: []
		});
	});

	it('accepts a copied path as a subject but leaves it out of the built list', () => {
		const holdsBothPaths: SelectedPathInfos = new Map([
			[builtPath, attestPathInfo(builtPath, 0xaa)],
			[substitutedPath, attestPathInfo(substitutedPath, 0xdd)]
		]);

		expect(
			provenancedSubjects(
				{
					version: 3,
					paths: [builtPath, substitutedPath],
					subjects: [
						provenancedSubject(builtPath, 'aa', 'local'),
						copiedSubject(substitutedPath, 'dd')
					]
				},
				holdsBothPaths
			)
		).toStrictEqual({
			subjects: [
				{ storePath: builtPath, sha256: 'aa'.repeat(32) },
				{ storePath: substitutedPath, sha256: 'dd'.repeat(32) }
			],
			built: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
			skipped: []
		});
	});

	it('leaves the deriver unchecked for a subject that records no deriver', () => {
		const held: SelectedPathInfos = new Map([
			[substitutedPath, attestPathInfo(substitutedPath, 0xdd)]
		]);
		const subject = {
			origin: 'copied' as const,
			storePath: substitutedPath,
			narHash: 'dd'.repeat(32),
			signatures: []
		};

		expect(
			provenancedSubjects(
				{ version: 3, paths: [substitutedPath], subjects: [subject] },
				held
			)
		).toStrictEqual({
			subjects: [{ storePath: substitutedPath, sha256: 'dd'.repeat(32) }],
			built: [],
			skipped: []
		});
	});
});

describe('buildOriginPredicateFor', () => {
	const builtPath = storePathSchema.parse(
		'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
	);
	const remotePath = storePathSchema.parse(
		'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
	);
	it('records the origin of every accepted subject and no other', () => {
		const receipt = buildReceiptSchema.parse({
			version: 3,
			paths: [builtPath, remotePath],
			subjects: [
				provenancedSubject(builtPath, 'aa', 'local'),
				{
					...provenancedSubject(remotePath, 'bb', 'build-store'),
					machine: 'ssh://builder-1'
				}
			]
		});
		const accepted = [acceptedDigest(builtPath, 'aa'.repeat(32))];

		expect(buildOriginPredicateFor(receipt, accepted)).toStrictEqual({
			subjects: [
				{
					origin: 'built',
					storePath: builtPath,
					narHash: 'aa'.repeat(32),
					derivation: `${builtPath}.drv`,
					buildStore: 'ssh-ng://builder.example',
					verification: 'local'
				}
			]
		});
	});

	it('preserves the recorded builder in the build-origin predicate', () => {
		const receipt = buildReceiptSchema.parse({
			version: 3,
			paths: [remotePath],
			subjects: [
				{
					...provenancedSubject(remotePath, 'bb', 'build-store'),
					machine: 'ssh://builder-1'
				}
			]
		});

		const accepted = [acceptedDigest(remotePath, 'bb'.repeat(32))];

		expect(buildOriginPredicateFor(receipt, accepted)).toStrictEqual({
			subjects: [
				{
					origin: 'built',
					storePath: remotePath,
					narHash: 'bb'.repeat(32),
					derivation: `${remotePath}.drv`,
					buildStore: 'ssh-ng://builder.example',
					machine: 'ssh://builder-1',
					verification: 'build-store'
				}
			]
		});
	});

	it.each([
		{
			name: 'a version 2 receipt, which records no origin',
			receipt: {
				version: 2,
				paths: [builtPath],
				subjects: [
					{
						storePath: builtPath,
						narHash: 'aa'.repeat(32),
						derivation: `${builtPath}.drv`,
						attempt: 1,
						attemptId: 'attempt-1'
					}
				]
			},
			accepted: [acceptedDigest(builtPath, 'aa'.repeat(32))]
		},
		{
			name: 'a run that accepted no subject',
			receipt: {
				version: 3,
				paths: [builtPath],
				subjects: [provenancedSubject(builtPath, 'aa', 'local')]
			},
			accepted: []
		}
	])('writes no predicate for $name', ({ receipt, accepted }) => {
		expect(
			buildOriginPredicateFor(buildReceiptSchema.parse(receipt), accepted)
		).toBeUndefined();
	});
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

		expect(inputs).toStrictEqual({
			receiptFile,
			url: new URL('https://cache.example.test/t/acme'),
			cache: { kind: 'named', name: 'builds' },
			readUser: 'reader',
			readPassword: 'secret',
			checksumsFile: '/runner/temp/cupboard-attestations/subjects.txt',
			builtChecksumsFile:
				'/runner/temp/cupboard-attestations/built-subjects.txt',
			predicateFile: '/runner/temp/cupboard-attestations/build-origin.json'
		});
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

		expect(inputs.predicateFile).toBe('/somewhere/build-origin.json');
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
			predicateFile: '/somewhere/build-origin.json'
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

describe('attestAction committed cache verification', () => {
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

	it('attests from the committed destination without access to the remote build store', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
		const receiptFile = await receiptFileIn(directory);
		const checksumsFile = path.join(directory, 'subjects.txt');
		const requests: { url: string; authorization?: string }[] = [];

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
						requests.push({
							url: requestUrl(input),
							authorization:
								new Headers(init?.headers).get('authorization') ?? undefined
						});

						return Promise.resolve(
							new Response(committedNarInfo(remotePath, 0xbb))
						);
					}
				}
			);

			expect({
				requests,
				checksums: await readFile(checksumsFile, 'utf8')
			}).toStrictEqual({
				requests: [
					{
						url: 'https://cache.example.test/t/acme/cache/builds/nix-cache-info',
						authorization: undefined
					},
					{
						url: 'https://cache.example.test/t/acme/cache/builds/3123456789abcdfghijklmnpqrsvwxyz.narinfo',
						authorization: `Basic ${Buffer.from('reader:secret').toString('base64')}`
					}
				],
				checksums: `${'bb'.repeat(32)}  ${path.basename(remotePath)}\n`
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('writes the build-origin predicate and reports both files', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
		const receiptFile = await receiptFileIn(directory);
		const checksumsFile = path.join(directory, 'subjects.txt');
		const predicateFile = path.join(directory, 'build-origin.json');
		const outputFile = path.join(directory, 'output');

		try {
			await attestAction(
				{
					receiptFile,
					checksumsFile,
					url: 'https://cache.example.test/t/acme'
				},
				{ RUNNER_TEMP: directory, GITHUB_OUTPUT: outputFile },
				createGithubReporter(),
				{
					fetch: () =>
						Promise.resolve(new Response(committedNarInfo(remotePath, 0xbb)))
				}
			);

			const outputs = await readFile(outputFile, 'utf8');
			const predicate: unknown = JSON.parse(
				await readFile(predicateFile, 'utf8')
			);

			expect({
				predicate,
				outputs: outputs
					.split('\n')
					.filter(
						(line) =>
							line.startsWith('predicate-file=') ||
							line.startsWith('predicate-type=')
					)
			}).toStrictEqual({
				predicate: {
					subjects: [
						{
							origin: 'built',
							storePath: remotePath,
							narHash: 'bb'.repeat(32),
							derivation: `${remotePath}.drv`,
							buildStore: 'ssh-ng://builder.example',
							verification: 'build-store'
						}
					]
				},
				outputs: [
					`predicate-file=${predicateFile}`,
					`predicate-type=${buildOriginPredicateType}`
				]
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		{ access: 'public', status: 200, selection: {} },
		{ access: 'private', status: 401, selection: { cache: 'builds' } }
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
						fetch: (input) =>
							Promise.resolve(
								requestUrl(input).endsWith('/nix-cache-info')
									? new Response(undefined, { status })
									: new Response(committedNarInfo(remotePath, 0xbb))
							)
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
							Promise.resolve(new Response(undefined, { status: 404 }))
					}
				)
			).rejects.toBeInstanceOf(CacheAccessProbeError);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('reports no predicate file for a receipt that records no origin', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
		const receiptFile = path.join(directory, 'receipt.json');
		const predicateFile = path.join(directory, 'build-origin.json');
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
					fetch: () =>
						Promise.resolve(new Response(committedNarInfo(remotePath, 0xbb)))
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
	});

	it('refuses a subject absent from the committed destination', async () => {
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
						fetch: (input) =>
							Promise.resolve(
								requestUrl(input).endsWith('/nix-cache-info')
									? new Response()
									: new Response(undefined, { status: 404 })
							)
					}
				)
			).rejects.toBeInstanceOf(CommittedSubjectUnavailableError);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('reports a cache authentication refusal', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
		const receiptFile = await receiptFileIn(directory);

		try {
			let failure: unknown;

			try {
				await attestAction(
					{
						receiptFile,
						checksumsFile: path.join(directory, 'subjects.txt'),
						url: 'https://cache.example.test/t/acme',
						readUser: 'reader',
						readPassword: 'wrong'
					},
					{ RUNNER_TEMP: directory },
					createGithubReporter(),
					{
						fetch: (input) =>
							Promise.resolve(
								requestUrl(input).endsWith('/nix-cache-info')
									? new Response()
									: new Response(undefined, { status: 401 })
							)
					}
				);
			} catch (error) {
				failure = error;
			}

			expect(failure).toBeInstanceOf(CommittedSubjectUnavailableError);

			if (failure instanceof CommittedSubjectUnavailableError) {
				expect({
					storePath: failure.storePath,
					status: failure.status
				}).toStrictEqual({ storePath: remotePath, status: 401 });
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		{
			name: 'malformed metadata',
			body: 'not a narinfo',
			expected: CommittedSubjectInvalidError
		},
		{
			name: 'metadata for another path',
			body: committedNarInfo(
				storePathSchema.parse(
					'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-other'
				),
				0xbb
			),
			expected: CommittedSubjectInvalidError
		},
		{
			name: 'a moved NAR hash',
			body: committedNarInfo(remotePath, 0xaa),
			expected: SubjectNarHashMovedError
		},
		{
			name: 'a moved deriver',
			body: committedNarInfo(
				remotePath,
				0xbb,
				'4123456789abcdfghijklmnpqrsvwxyz-other.drv'
			),
			expected: SubjectDeriverMovedError
		}
	])('refuses $name from the destination cache', async ({ body, expected }) => {
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
					{ fetch: () => Promise.resolve(new Response(body)) }
				)
			).rejects.toBeInstanceOf(expected);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
