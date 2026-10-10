import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { StorePath } from '@cupboard/nix-store/store-path';
import { buildReceiptSchema } from '@cupboard/protocol/build';
import { ResultLink, ResultTable } from '@cupboard/reporter';
import { UsageError } from '@cupboard/shared/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../program.ts';

const mocks = vi.hoisted(() => ({
	runCupboard: vi.fn<typeof import('../cupboard-run.ts').runCupboard>(),
	result: vi.fn<import('@cupboard/reporter').Reporter['result']>()
}));
vi.mock('@cupboard/reporter', async (importOriginal) => {
	const original = await importOriginal<typeof import('@cupboard/reporter')>();
	return {
		...original,
		createGithubReporter: () => ({
			...original.createGithubReporter(),
			result: mocks.result
		})
	};
});
vi.mock('../cupboard-run.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../cupboard-run.ts')>()),
	runCupboard: mocks.runCupboard
}));

const app = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const dependency = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-dependency';
const absent = '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-absent';
const unattested = '/nix/store/5123456789abcdfghijklmnpqrsvwxyz-unattested';
const freshBundle = Buffer.from('freshly signed bundle');
const freshDigest = createHash('sha256').update(freshBundle).digest('hex');
const oldDigest = '2'.repeat(64);
const narHash = NixSha256Hash.fromDigest(
	Buffer.from('1'.repeat(64), 'hex')
).value;
const directories: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	mocks.runCupboard.mockReset();
	mocks.result.mockReset();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function fixture(
	options: {
		readonly version?: 2 | 3;
		readonly subjectCount?: number;
		readonly copied?: boolean;
	} = {}
) {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-coverage-'));
	directories.push(directory);
	const receipt = path.join(directory, 'receipt.json');
	await writeFile(
		receipt,
		JSON.stringify({
			version: options.version ?? 3,
			paths: [app, dependency, unattested, absent],
			subjects: [app, dependency, unattested, absent]
				.slice(0, options.subjectCount ?? 4)
				.map((storePath) => ({
					storePath,
					narHash: '1'.repeat(64),
					...(options.version === 2
						? {
								derivation: `${storePath}.drv`,
								attempt: 1,
								attemptId: 'attempt-1'
							}
						: storePath === unattested && options.copied === true
							? {
									origin: 'copied',
									signatures: [],
									copiedFrom: ['https://cache.nixos.org']
								}
							: { origin: 'store-held', buildStore: 'auto' })
				}))
		})
	);
	const bundle = path.join(directory, 'bundle.json');
	const bundles = path.join(directory, 'bundles.txt');
	await writeFile(bundle, freshBundle);
	await writeFile(bundles, `${bundle}\n`);
	return { directory, receipt, bundles };
}

function entries() {
	return [
		{
			storePathHash: StorePath.hash(app),
			status: 'found',
			narHash,
			attestations: [
				{
					digest: freshDigest,
					predicateType: 'https://slsa.dev/provenance/v1',
					size: freshBundle.length
				},
				{
					digest: oldDigest,
					predicateType: 'https://slsa.dev/provenance/v1',
					size: 123
				}
			]
		},
		{
			storePathHash: StorePath.hash(dependency),
			status: 'found',
			narHash,
			attestations: [
				{
					digest: oldDigest,
					predicateType: 'https://slsa.dev/provenance/v1',
					size: 123
				}
			]
		},
		{
			storePathHash: StorePath.hash(unattested),
			status: 'found',
			narHash,
			attestations: []
		},
		{ storePathHash: StorePath.hash(absent), status: 'missing' }
	];
}

describe('publication attestation coverage', () => {
	it('rejects subjects outside the receipt path list before discovery', async () => {
		const files = await fixture();
		const receipt = buildReceiptSchema.parse(
			JSON.parse(await readFile(files.receipt, 'utf8'))
		);
		await writeFile(
			files.receipt,
			JSON.stringify({ ...receipt, paths: [app] })
		);
		mocks.runCupboard.mockResolvedValue([
			{ kind: 'attestation-status', data: { entries: entries() } }
		]);
		let result: { exitCode: number; message: string } | undefined;
		try {
			await buildProgram({ RUNNER_TEMP: files.directory }).parseAsync([
				'node',
				'action',
				'attest-status',
				'--url',
				'https://cupboard.example.workers.dev/t/acme',
				'--cupboard-path',
				'/bin/cupboard',
				'--receipt-file',
				files.receipt
			]);
		} catch (error) {
			if (!(error instanceof UsageError)) {
				throw error;
			}
			result = { exitCode: error.exitCode, message: error.message };
		}
		expect({ result, queries: mocks.runCupboard.mock.calls }).toStrictEqual({
			result: {
				exitCode: 2,
				message:
					'The publication receipt contains conflicting path identities or subjects outside its path list.'
			},
			queries: []
		});
	});

	it.each([
		{ signed: true, version: 3 as const, subjectCount: 4, copied: false },
		{ signed: true, version: 3 as const, subjectCount: 4, copied: true },
		{ signed: false, version: 3 as const, subjectCount: 4 },
		{ signed: false, version: 2 as const, subjectCount: 1 },
		{ signed: false, version: 2 as const, subjectCount: 0 },
		{ signed: false, version: 3 as const, subjectCount: 1 }
	])(
		'reports every receipt path with version $version, $subjectCount subjects and signing $signed',
		async ({ signed, version, subjectCount, copied }) => {
			const files = await fixture({ version, subjectCount, copied });
			let queried: readonly string[] = [];
			let manifest = '';
			mocks.runCupboard.mockImplementation(
				async (_binary: string, arguments_: readonly string[]) => {
					manifest = arguments_[arguments_.indexOf('--paths-file') + 1] ?? '';
					const contents = await readFile(manifest, 'utf8');
					queried = contents.trim().split('\n');
					return [
						{
							kind: 'attestation-status',
							data: {
								entries: entries().filter((entry) =>
									queried.some(
										(storePath) =>
											StorePath.hash(storePath) === entry.storePathHash
									)
								),
								covered: [StorePath.hash(app), StorePath.hash(dependency)],
								withoutEvidence:
									copied === true ? [] : [StorePath.hash(unattested)],
								fetchedUpstream:
									copied === true ? [StorePath.hash(unattested)] : [],
								missing: [StorePath.hash(absent)]
							}
						}
					];
				}
			);
			const program = buildProgram({ RUNNER_TEMP: files.directory });
			await program.parseAsync([
				'node',
				'action',
				'attest-status',
				'--url',
				'https://cupboard.example.workers.dev/t/acme',
				'--cache',
				'pr-1',
				'--cupboard-path',
				'/bin/cupboard',
				'--receipt-file',
				files.receipt,
				...(signed ? ['--bundles-file', files.bundles] : [])
			]);
			const expectedTable = ResultTable.of(
				[
					{ key: 'path', label: 'Path' },
					{ key: 'evidence', label: 'Stored attestation' }
				],
				[
					{
						path: app,
						evidence: new ResultLink(
							'Bundle',
							new URL(
								`https://cupboard.example.workers.dev/t/acme/cache/pr-1/attestation-bundles/${freshDigest}`
							)
						)
					},
					{
						path: dependency,
						evidence: new ResultLink(
							'Bundle',
							new URL(
								`https://cupboard.example.workers.dev/t/acme/cache/pr-1/attestation-bundles/${oldDigest}`
							)
						)
					},
					{ path: unattested, evidence: 'No stored evidence' },
					{ path: absent, evidence: 'Missing published path' }
				]
			);

			expect({
				queried,
				results: mocks.result.mock.calls,
				arguments: mocks.runCupboard.mock.calls[0]?.[1]
			}).toStrictEqual({
				queried: [app, dependency, unattested, absent],
				arguments: [
					'--no-colour',
					'attest',
					'status',
					'https://cupboard.example.workers.dev/t/acme/cache/pr-1',
					'--paths-file',
					manifest
				],
				results: [
					[
						{
							kind: 'publication-attestation-coverage',
							title: 'Published attestation coverage (not verified)',
							jobSummary: true,
							table: expectedTable,
							data: {
								entries: entries(),
								freshlySigned: signed ? [StorePath.hash(app)] : [],
								previouslyStored: signed
									? [StorePath.hash(dependency)]
									: [StorePath.hash(app), StorePath.hash(dependency)],
								withoutEvidence:
									copied === true ? [] : [StorePath.hash(unattested)],
								fetchedUpstream:
									copied === true ? [StorePath.hash(unattested)] : [],
								missing: [StorePath.hash(absent)]
							},
							rows: [
								{
									label: 'Freshly signed and stored paths',
									value: signed ? '1' : '0'
								},
								{
									label: 'Paths with previously stored evidence',
									value: signed ? '1' : '2'
								},
								{
									label: 'Fetched upstream, not attested',
									value: copied === true ? '1' : '0'
								},
								{
									label: 'Other paths without stored evidence',
									value: copied === true ? '0' : '1'
								},
								{ label: 'Missing published paths', value: '1' }
							]
						}
					]
				]
			});
			await expect(readFile(manifest)).rejects.toMatchObject({
				code: 'ENOENT'
			});
		}
	);

	it.each([77, 75])(
		'preserves a discovery failure with exit %s and cleans its manifest',
		async (status) => {
			const files = await fixture();
			const failure = Object.assign(new Error('Discovery refused'), {
				exitCode: status
			});
			let manifest = '';
			mocks.runCupboard.mockImplementation(
				(_binary: string, arguments_: readonly string[]) => {
					manifest = arguments_[arguments_.indexOf('--paths-file') + 1] ?? '';
					return Promise.reject(failure);
				}
			);
			await expect(
				buildProgram({ RUNNER_TEMP: files.directory }).parseAsync([
					'node',
					'action',
					'attest-status',
					'--url',
					'https://cupboard.example.workers.dev/t/acme',
					'--cupboard-path',
					'/bin/cupboard',
					'--receipt-file',
					files.receipt
				])
			).rejects.toBe(failure);
			await expect(readFile(manifest)).rejects.toMatchObject({
				code: 'ENOENT'
			});
		}
	);
});
