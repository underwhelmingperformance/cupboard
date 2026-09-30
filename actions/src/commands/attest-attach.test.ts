import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { StorePath } from '@cupboard/nix-store/store-path';
import { buildOriginPredicateType } from '@cupboard/protocol/build-origin';
import type { Reporter } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	AttestationBundlesMissingError,
	AttestationChecksumsMismatchError,
	MissingInputError,
	ReadPasswordRequiredError,
	ReadUserRequiredError
} from '../errors.ts';

import {
	attestAttachAction,
	attestAttachArguments,
	type AttestAttachOptions,
	resolveAttestAttachInputs
} from './attest-attach.ts';

const appPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const runtimePath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime';

function options(
	overrides: Partial<AttestAttachOptions> = {}
): AttestAttachOptions {
	return {
		url: 'https://cache.example.workers.dev/t/acme',
		cupboardPath: '/opt/cupboard/cupboard',
		receiptFile: '/tmp/receipt.json',
		checksumsFile: '/tmp/subjects.txt',
		bundle: ['/tmp/bundle.sigstore.json'],
		...overrides
	};
}

interface ReceiptFixture {
	readonly receiptFile: string;
	readonly checksumsFile: string;
}

interface BundleSpec {
	readonly predicateType: string;
	readonly paths: readonly string[];
}

async function writeBundleManifest(
	fixture: ReceiptFixture,
	specifications: readonly BundleSpec[]
): Promise<{
	readonly bundlesFile: string;
	readonly bundleFiles: readonly string[];
}> {
	const directory = path.dirname(fixture.receiptFile);
	const bundlesFile = path.join(directory, 'bundles.txt');
	const bundleFiles: string[] = [];

	for (const [index, specification] of specifications.entries()) {
		const bundleFile = path.join(
			directory,
			`bundle-${String(index)}.sigstore.json`
		);
		const statement = {
			_type: 'https://in-toto.io/Statement/v1',
			predicateType: specification.predicateType,
			predicate: {},
			subject: specification.paths.map((storePath) => ({
				name: path.basename(storePath),
				digest: { sha256: (storePath === appPath ? '1' : '2').repeat(64) }
			}))
		};
		const payload = Buffer.from(JSON.stringify(statement)).toString('base64');
		await writeFile(bundleFile, JSON.stringify({ dsseEnvelope: { payload } }));
		bundleFiles.push(bundleFile);
	}

	await writeFile(bundlesFile, `${bundleFiles.join('\n')}\n`);
	return { bundlesFile, bundleFiles };
}

async function pathsFromAttachArguments(
	arguments_: readonly string[]
): Promise<readonly string[]> {
	const file = arguments_[arguments_.indexOf('--paths-file') + 1];
	if (file === undefined) {
		throw new Error('Expected a path file');
	}

	const contents = await readFile(file, 'utf8');
	return contents.trim().split('\n');
}

async function bundlesFromAttachArguments(
	arguments_: readonly string[]
): Promise<readonly string[]> {
	const file = arguments_[arguments_.indexOf('--attestations-file') + 1];
	if (file === undefined) {
		throw new Error('Expected an attestations file');
	}
	const contents = await readFile(file, 'utf8');
	return contents.trim().split('\n');
}

async function expandAttachManifestArguments(
	arguments_: readonly string[]
): Promise<readonly string[]> {
	const paths = await pathsFromAttachArguments(arguments_);
	const bundles = await bundlesFromAttachArguments(arguments_);
	const expanded: string[] = [];
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === '--paths-file') {
			expanded.push(...paths);
			index += 1;
			continue;
		}
		if (argument === '--attestations-file') {
			expanded.push(...bundles.flatMap((bundle) => ['--attestation', bundle]));
			index += 1;
			continue;
		}
		if (argument !== undefined) {
			expanded.push(argument);
		}
	}
	return expanded;
}

function fileCapableCommandOptions(): Promise<ReadonlySet<string>> {
	return Promise.resolve(new Set(['--paths-file', '--attestations-file']));
}

async function writeReceipt(paths: readonly string[]): Promise<ReceiptFixture> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attach-'));
	const receiptFile = path.join(directory, 'receipt.json');
	const checksumsFile = path.join(directory, 'subjects.txt');
	await writeFile(
		receiptFile,
		JSON.stringify({
			version: 2,
			paths,
			subjects: paths.map((storePath, index) => ({
				storePath,
				narHash: String(index + 1).repeat(64),
				derivation: `${storePath}.drv`,
				attempt: 1,
				attemptId: 'one'
			}))
		})
	);
	await writeFile(
		checksumsFile,
		paths
			.map(
				(storePath, index) =>
					`${String(index + 1).repeat(64)}  ${path.basename(storePath)}`
			)
			.join('\n')
			.concat(paths.length === 0 ? '' : '\n')
	);

	return { receiptFile, checksumsFile };
}

async function writeMixedReceipt(): Promise<ReceiptFixture> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attach-'));
	const receiptFile = path.join(directory, 'receipt.json');
	const checksumsFile = path.join(directory, 'subjects.txt');
	const heldPath = '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-held';
	const republishedPath =
		'/nix/store/5123456789abcdfghijklmnpqrsvwxyz-republished';
	await writeFile(
		receiptFile,
		JSON.stringify({
			version: 3,
			paths: [appPath, runtimePath, heldPath, republishedPath],
			subjects: [
				{
					origin: 'built',
					storePath: appPath,
					narHash: '1'.repeat(64),
					derivation: `${appPath}.drv`,
					buildStore: 'auto',
					verification: 'local'
				},
				{
					origin: 'copied',
					storePath: runtimePath,
					narHash: '2'.repeat(64),
					signatures: []
				},
				{
					origin: 'store-held',
					storePath: heldPath,
					narHash: '3'.repeat(64),
					buildStore: 'auto'
				},
				{
					origin: 'republished',
					storePath: republishedPath,
					narHash: '4'.repeat(64),
					signatures: [],
					metadataSource: 'https://cache.example.test'
				}
			]
		})
	);
	await writeFile(
		checksumsFile,
		`${'1'.repeat(64)}  ${path.basename(appPath)}\n${'2'.repeat(64)}  ${path.basename(runtimePath)}\n`
	);

	return { receiptFile, checksumsFile };
}

function recordingReporter(warnings: string[]): Reporter {
	const recordWarn = (label: string, value?: string): void => {
		warnings.push(value === undefined ? label : `${label}: ${value}`);
	};

	return {
		phase: (_label, body) =>
			Promise.resolve(
				body({
					fact() {
						return;
					},
					warn: recordWarn
				})
			),
		progress: (_label, _options, body) =>
			Promise.resolve(
				body({
					advance() {
						return;
					},
					fact() {
						return;
					},
					warn: recordWarn
				})
			),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message() {
						return;
					},
					group: () => ({
						message() {
							return;
						},
						success() {
							return;
						},
						error() {
							return;
						}
					}),
					warn: recordWarn
				})
			),
		result() {
			return;
		},
		data() {
			return;
		},
		error() {
			return;
		},
		warn: recordWarn,
		info() {
			return;
		},
		success() {
			return;
		},
		step() {
			return;
		}
	};
}

function attachedResults(paths: readonly string[]) {
	return [
		{
			kind: 'attestation-attach-summary',
			data: {
				attached: paths.length,
				reused: 0,
				unservable: 0,
				uploadedBytes: 1,
				paths: paths.map((storePath) => ({
					storePathHash: StorePath.hash(storePath),
					storePath,
					outcome: 'attached' as const
				}))
			}
		}
	];
}

describe('resolveAttestAttachInputs', () => {
	it('requires a receipt of eligible paths', () => {
		expect(() =>
			resolveAttestAttachInputs(options({ receiptFile: '' }))
		).toThrow(MissingInputError);
	});

	it('resolves the provided inputs', () => {
		expect(
			resolveAttestAttachInputs(
				options({
					cache: 'pr-1',
					audience: 'https://audience.test',
					readUser: 'reader',
					readPassword: 'secret'
				})
			)
		).toStrictEqual({
			url: new URL('https://cache.example.workers.dev/t/acme'),
			cupboardPath: '/opt/cupboard/cupboard',
			cache: { kind: 'named', name: 'pr-1' },
			audience: 'https://audience.test',
			readUser: 'reader',
			readPassword: 'secret',
			receiptFile: '/tmp/receipt.json',
			checksumsFile: '/tmp/subjects.txt',
			bundles: ['/tmp/bundle.sigstore.json'],
			bundlesFile: ''
		});
	});

	it.each([
		{
			name: 'url',
			overrides: { url: '' },
			expected: MissingInputError
		},
		{
			name: 'cupboard-path',
			overrides: { cupboardPath: '' },
			expected: MissingInputError
		},
		{
			name: 'receipt-file',
			overrides: { receiptFile: '' },
			expected: MissingInputError
		},
		{
			name: 'checksums-file',
			overrides: { checksumsFile: '' },
			expected: MissingInputError
		},
		{
			name: 'bundle',
			overrides: { bundle: [] as readonly string[] },
			expected: AttestationBundlesMissingError
		}
	])('requires $name', ({ overrides, expected }) => {
		expect(() => resolveAttestAttachInputs(options(overrides))).toThrow(
			expected
		);
	});

	it.each([
		{
			name: 'read-user alone',
			overrides: { readUser: 'reader' },
			errorType: ReadPasswordRequiredError
		},
		{
			name: 'read-password alone',
			overrides: { readPassword: 'secret' },
			errorType: ReadUserRequiredError
		}
	])('refuses $name', ({ overrides, errorType }) => {
		expect(() => resolveAttestAttachInputs(options(overrides))).toThrow(
			errorType
		);
	});
});

describe('attestAttachArguments', () => {
	it('builds the attach argv for the receipt paths', () => {
		const inputs = resolveAttestAttachInputs(
			options({
				cache: 'pr-1',
				audience: 'https://audience.test',
				readUser: 'reader',
				readPassword: 'secret'
			})
		);

		expect(
			attestAttachArguments(inputs, [appPath, runtimePath], 'url')
		).toStrictEqual([
			'--no-colour',
			'attest',
			'attach',
			'https://cache.example.workers.dev/t/acme/cache/pr-1',
			appPath,
			runtimePath,
			'--github-oidc',
			'--audience',
			'https://audience.test',
			'--read-user',
			'reader',
			'--read-password',
			'secret',
			'--attestation',
			'/tmp/bundle.sigstore.json'
		]);
	});

	it('selects the named cache through the legacy CLI flag', () => {
		const inputs = resolveAttestAttachInputs(options({ cache: 'pr-1' }));

		expect(attestAttachArguments(inputs, [appPath], 'flag')).toStrictEqual([
			'--no-colour',
			'attest',
			'attach',
			'https://cache.example.workers.dev/t/acme',
			appPath,
			'--github-oidc',
			'--cache',
			'pr-1',
			'--attestation',
			'/tmp/bundle.sigstore.json'
		]);
	});

	it('omits the audience and cache flags when not provided', () => {
		const inputs = resolveAttestAttachInputs(options());

		expect(attestAttachArguments(inputs, [appPath], 'url')).toStrictEqual([
			'--no-colour',
			'attest',
			'attach',
			'https://cache.example.workers.dev/t/acme',
			appPath,
			'--github-oidc',
			'--attestation',
			'/tmp/bundle.sigstore.json'
		]);
	});

	it('attaches the build-provenance and build-origin bundles of one run', () => {
		const inputs = resolveAttestAttachInputs(
			options({
				bundle: [
					'/tmp/provenance.sigstore.json',
					'/tmp/build-origin.sigstore.json'
				]
			})
		);

		expect(attestAttachArguments(inputs, [appPath], 'url')).toStrictEqual([
			'--no-colour',
			'attest',
			'attach',
			'https://cache.example.workers.dev/t/acme',
			appPath,
			'--github-oidc',
			'--attestation',
			'/tmp/provenance.sigstore.json',
			'--attestation',
			'/tmp/build-origin.sigstore.json'
		]);
	});
});

describe('attestAttachAction', () => {
	it('attaches overlapping SLSA and explicit custom predicate subjects in one manifest batch', async () => {
		const fixture = await writeReceipt([appPath, runtimePath]);
		try {
			const manifest = await writeBundleManifest(fixture, [
				{ predicateType: 'https://slsa.dev/provenance/v1', paths: [appPath] },
				{
					predicateType: buildOriginPredicateType,
					paths: [appPath, runtimePath]
				}
			]);
			const calls: {
				readonly paths: readonly string[];
				readonly bundles: readonly string[];
			}[] = [];

			await attestAttachAction(
				options({ ...fixture, bundle: [], bundlesFile: manifest.bundlesFile }),
				{},
				recordingReporter([]),
				{
					inspectCommandOptions: () =>
						Promise.resolve(new Set(['--paths-file', '--attestations-file'])),
					runCupboard: async (_binaryPath, arguments_) => {
						const paths = await pathsFromAttachArguments(arguments_);
						calls.push({
							paths,
							bundles: await bundlesFromAttachArguments(arguments_)
						});
						return attachedResults(paths);
					}
				}
			);

			expect(calls).toStrictEqual([
				{ paths: [appPath, runtimePath], bundles: manifest.bundleFiles }
			]);
		} finally {
			await rm(path.dirname(fixture.receiptFile), {
				recursive: true,
				force: true
			});
		}
	});

	it('rejects a CLI summary that omits a selected subject', async () => {
		const fixture = await writeReceipt([appPath, runtimePath]);
		try {
			const manifest = await writeBundleManifest(fixture, [
				{ predicateType: buildOriginPredicateType, paths: [appPath] }
			]);
			const calls: (readonly string[])[] = [];

			await expect(
				attestAttachAction(
					options({
						...fixture,
						bundle: [],
						bundlesFile: manifest.bundlesFile
					}),
					{},
					recordingReporter([]),
					{
						inspectCommandOptions: () =>
							Promise.resolve(new Set(['--paths-file', '--attestations-file'])),
						runCupboard: async (_binaryPath, arguments_) => {
							const paths = await pathsFromAttachArguments(arguments_);
							calls.push(paths);
							return attachedResults([appPath]);
						}
					}
				)
			).rejects.toThrow(
				`Attestation attachment was incomplete for: ${runtimePath}`
			);
			expect(calls).toStrictEqual([[appPath, runtimePath]]);
		} finally {
			await rm(path.dirname(fixture.receiptFile), {
				recursive: true,
				force: true
			});
		}
	});

	it('rejects an incomplete aggregate summary after the CLI processes several bundle pages', async () => {
		const fixture = await writeReceipt([appPath, runtimePath]);
		try {
			const manifest = await writeBundleManifest(fixture, [
				...Array.from({ length: 64 }, () => ({
					predicateType: buildOriginPredicateType,
					paths: [appPath]
				})),
				{ predicateType: buildOriginPredicateType, paths: [runtimePath] }
			]);
			const calls: (readonly string[])[] = [];

			await expect(
				attestAttachAction(
					options({
						...fixture,
						bundle: [],
						bundlesFile: manifest.bundlesFile
					}),
					{},
					recordingReporter([]),
					{
						inspectCommandOptions: () =>
							Promise.resolve(new Set(['--paths-file', '--attestations-file'])),
						runCupboard: async (_binaryPath, arguments_) => {
							const paths = await pathsFromAttachArguments(arguments_);
							calls.push(paths);
							return attachedResults([appPath]);
						}
					}
				)
			).rejects.toThrow(
				`Attestation attachment was incomplete for: ${runtimePath}`
			);
			expect(calls).toStrictEqual([[appPath, runtimePath]]);
		} finally {
			await rm(path.dirname(fixture.receiptFile), {
				recursive: true,
				force: true
			});
		}
	});

	it('uses path files with the legacy named-cache flag', async () => {
		const fixture = await writeReceipt([appPath]);
		try {
			const manifest = await writeBundleManifest(fixture, [
				{ predicateType: buildOriginPredicateType, paths: [appPath] }
			]);
			const calls: {
				readonly arguments: readonly string[];
				readonly paths: readonly string[];
			}[] = [];

			await attestAttachAction(
				options({
					...fixture,
					bundle: [],
					bundlesFile: manifest.bundlesFile,
					cache: 'pr-1',
					audience: 'https://audience.test',
					readUser: 'reader',
					readPassword: 'secret'
				}),
				{},
				recordingReporter([]),
				{
					inspectCommandOptions: () =>
						Promise.resolve(
							new Set(['--paths-file', '--attestations-file', '--cache'])
						),
					runCupboard: async (_binaryPath, arguments_) => {
						const paths = await pathsFromAttachArguments(arguments_);
						calls.push({
							arguments: arguments_.filter(
								(_argument, index) =>
									!['--paths-file', '--attestations-file'].includes(
										arguments_[index - 1] ?? ''
									)
							),
							paths
						});
						return attachedResults(paths);
					}
				}
			);

			expect(calls).toStrictEqual([
				{
					arguments: [
						'--no-colour',
						'attest',
						'attach',
						'https://cache.example.workers.dev/t/acme',
						'--paths-file',
						'--github-oidc',
						'--audience',
						'https://audience.test',
						'--cache',
						'pr-1',
						'--read-user',
						'reader',
						'--read-password',
						'secret',
						'--attestations-file'
					],
					paths: [appPath]
				}
			]);
		} finally {
			await rm(path.dirname(fixture.receiptFile), {
				recursive: true,
				force: true
			});
		}
	});

	it('transports grouped public bundles in one CLI invocation', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attach-'));
		try {
			const receiptFile = path.join(directory, 'receipt.json');
			const checksumsFile = path.join(directory, 'subjects.txt');
			const bundlesFile = path.join(directory, 'bundles.txt');
			const paths = Array.from(
				{ length: 3200 },
				(_, index) =>
					`/nix/store/${String(index).padStart(32, '0')}-package-${String(index)}`
			);
			const subjects = paths.map((storePath, index) => ({
				storePath,
				narHash: index.toString(16).padStart(64, '0'),
				derivation: `${storePath}.drv`,
				attempt: 1,
				attemptId: 'one'
			}));
			await writeFile(
				receiptFile,
				JSON.stringify({ version: 2, paths, subjects })
			);
			await writeFile(
				checksumsFile,
				subjects
					.map(
						(subject) =>
							`${subject.narHash}  ${path.basename(subject.storePath)}`
					)
					.join('\n') + '\n'
			);
			const bundleFiles = Array.from({ length: 1600 }, (_, index) =>
				path.join(directory, `group-${String(index)}.sigstore.json`)
			);
			await writeFile(bundlesFile, `${bundleFiles.join('\n')}\n`);
			const calls: {
				readonly argumentCount: number;
				readonly bundles: readonly string[];
				readonly paths: readonly string[];
			}[] = [];

			await attestAttachAction(
				options({ receiptFile, checksumsFile, bundle: [], bundlesFile }),
				{},
				recordingReporter([]),
				{
					inspectCommandOptions: () =>
						Promise.resolve(new Set(['--paths-file', '--attestations-file'])),
					runCupboard: async (_binaryPath, arguments_) => {
						const selectedPaths = await pathsFromAttachArguments(arguments_);
						calls.push({
							argumentCount: arguments_.length,
							bundles: await bundlesFromAttachArguments(arguments_),
							paths: selectedPaths
						});
						return attachedResults(selectedPaths);
					}
				}
			);

			expect(calls).toStrictEqual([
				{ paths, bundles: bundleFiles, argumentCount: 9 }
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('transports individual private bundles in one CLI invocation', async () => {
		const fixture = await writeReceipt([appPath]);
		const directory = path.dirname(fixture.receiptFile);
		try {
			const bundlesFile = path.join(directory, 'bundles.txt');
			const bundleFiles = Array.from({ length: 20_000 }, (_, index) =>
				path.join(directory, `bundle-${String(index)}.sigstore.json`)
			);
			await writeFile(bundlesFile, `${bundleFiles.join('\n')}\n`);
			const batches: {
				readonly bundles: readonly string[];
				readonly paths: readonly string[];
			}[] = [];

			await attestAttachAction(
				options({ ...fixture, bundle: [], bundlesFile }),
				{},
				recordingReporter([]),
				{
					inspectCommandOptions: () =>
						Promise.resolve(new Set(['--paths-file', '--attestations-file'])),
					runCupboard: async (_binaryPath, arguments_) => {
						const file = arguments_[arguments_.indexOf('--paths-file') + 1];
						if (file === undefined) {
							throw new Error('Expected a path file');
						}
						const contents = await readFile(file, 'utf8');
						const paths = contents.trim().split('\n');
						const files = await bundlesFromAttachArguments(arguments_);
						batches.push({ bundles: files, paths });
						return attachedResults(paths);
					}
				}
			);

			expect(batches).toStrictEqual([
				{ bundles: bundleFiles, paths: [appPath] }
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		{
			description: 'a bundle manifest',
			paths: [appPath],
			hasManifest: true,
			bundleCount: 1
		},
		{
			description: 'several selected subjects',
			paths: [appPath, runtimePath],
			hasManifest: false,
			bundleCount: 1
		},
		{
			description: 'a large direct bundle list',
			paths: [appPath],
			hasManifest: false,
			bundleCount: 2000
		}
	])(
		'requires a file-capable CLI for $description',
		async ({ paths, hasManifest, bundleCount }) => {
			const fixture = await writeReceipt(paths);
			try {
				const bundleList = await writeBundleManifest(fixture, [
					{
						predicateType: buildOriginPredicateType,
						paths
					}
				]);
				const directBundles = Array.from(
					{ length: bundleCount },
					(_, index) => `/tmp/bundle-${String(index)}.sigstore.json`
				);
				await expect(
					attestAttachAction(
						options({
							...fixture,
							bundle: directBundles,
							...(hasManifest && {
								bundle: [],
								bundlesFile: bundleList.bundlesFile
							})
						}),
						{},
						recordingReporter([]),
						{
							inspectCommandOptions: () =>
								Promise.resolve(new Set(['--paths-file'])),
							runCupboard: () => {
								throw new Error(
									'An older CLI must not attach several subjects'
								);
							}
						}
					)
				).rejects.toThrow(
					'Update cupboard before retrying attestation attachment'
				);
			} finally {
				await rm(path.dirname(fixture.receiptFile), {
					recursive: true,
					force: true
				});
			}
		}
	);

	it('uses the older CLI syntax for one subject and bounded direct bundles', async () => {
		const fixture = await writeReceipt([appPath]);
		const calls: unknown[] = [];

		await attestAttachAction(
			options({ ...fixture, cache: 'pr-1' }),
			{},
			recordingReporter([]),
			{
				inspectCommandOptions: () => {
					throw new Error('Legacy attachment must not require file options');
				},
				detectCacheSelectionSyntax: (binary, command) => {
					calls.push({ probe: [binary, command] });
					return Promise.resolve('flag');
				},
				runCupboard: (binary, arguments_) => {
					calls.push({ run: [binary, arguments_] });
					return Promise.resolve(attachedResults([appPath]));
				}
			}
		);

		expect(calls).toStrictEqual([
			{ probe: ['/opt/cupboard/cupboard', ['attest', 'attach']] },
			{
				run: [
					'/opt/cupboard/cupboard',
					[
						'--no-colour',
						'attest',
						'attach',
						'https://cache.example.workers.dev/t/acme',
						appPath,
						'--github-oidc',
						'--cache',
						'pr-1',
						'--attestation',
						'/tmp/bundle.sigstore.json'
					]
				]
			}
		]);
	});

	it('invokes the installed cupboard with the receipt paths and bundle', async () => {
		const fixture = await writeReceipt([appPath, runtimePath]);
		const controller = new AbortController();
		const invocations: {
			binaryPath: string;
			arguments: readonly string[];
			dependencies: { readonly signal?: AbortSignal } | undefined;
		}[] = [];

		await attestAttachAction(
			options({
				...fixture,
				readUser: 'reader',
				readPassword: 'secret'
			}),
			{},
			recordingReporter([]),
			{
				inspectCommandOptions: fileCapableCommandOptions,
				runCupboard: async (
					binaryPath,
					arguments_,
					_environment,
					dependencies
				) => {
					invocations.push({
						binaryPath,
						arguments: await expandAttachManifestArguments(arguments_),
						dependencies
					});

					return attachedResults([appPath, runtimePath]);
				},
				signal: controller.signal
			}
		);

		expect(invocations).toStrictEqual([
			{
				binaryPath: '/opt/cupboard/cupboard',
				arguments: [
					'--no-colour',
					'attest',
					'attach',
					'https://cache.example.workers.dev/t/acme',
					appPath,
					runtimePath,
					'--github-oidc',
					'--read-user',
					'reader',
					'--read-password',
					'secret',
					'--attestation',
					'/tmp/bundle.sigstore.json'
				],
				dependencies: { signal: controller.signal }
			}
		]);
	});

	it('passes every receipt subject to the attach invocation', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attach-'));
		const receiptFile = path.join(directory, 'receipt.json');
		const checksumsFile = path.join(directory, 'subjects.txt');
		const sharedHash = 'a'.repeat(64);
		await writeFile(
			receiptFile,
			JSON.stringify({
				version: 3,
				paths: [appPath, runtimePath],
				subjects: [
					{
						origin: 'built',
						storePath: appPath,
						narHash: sharedHash,
						derivation: `${appPath}.drv`,
						buildStore: 'auto',
						verification: 'local'
					},
					{
						origin: 'built',
						storePath: runtimePath,
						narHash: sharedHash,
						derivation: `${runtimePath}.drv`,
						buildStore: 'auto',
						machine: 'ssh://builder.example',
						verification: 'build-store'
					}
				]
			})
		);
		await writeFile(
			checksumsFile,
			`${sharedHash}  ${path.basename(appPath)}\n` +
				`${sharedHash}  ${path.basename(runtimePath)}\n`
		);
		const invocations: string[][] = [];

		await attestAttachAction(
			options({ receiptFile, checksumsFile }),
			{},
			recordingReporter([]),
			{
				inspectCommandOptions: fileCapableCommandOptions,
				runCupboard: async (_binaryPath, arguments_) => {
					invocations.push([
						...(await expandAttachManifestArguments(arguments_))
					]);

					return attachedResults([appPath, runtimePath]);
				}
			}
		);

		expect(invocations).toStrictEqual([
			[
				'--no-colour',
				'attest',
				'attach',
				'https://cache.example.workers.dev/t/acme',
				appPath,
				runtimePath,
				'--github-oidc',
				'--attestation',
				'/tmp/bundle.sigstore.json'
			]
		]);
	});

	it('attaches only selected built and copied subjects from a mixed receipt', async () => {
		const fixture = await writeMixedReceipt();
		const invocations: string[][] = [];

		await attestAttachAction(options(fixture), {}, recordingReporter([]), {
			inspectCommandOptions: fileCapableCommandOptions,
			runCupboard: async (_binaryPath, arguments_) => {
				invocations.push([
					...(await expandAttachManifestArguments(arguments_))
				]);

				return attachedResults([appPath, runtimePath]);
			}
		});

		expect(invocations).toStrictEqual([
			[
				'--no-colour',
				'attest',
				'attach',
				'https://cache.example.workers.dev/t/acme',
				appPath,
				runtimePath,
				'--github-oidc',
				'--attestation',
				'/tmp/bundle.sigstore.json'
			]
		]);
	});

	it('attaches only built subjects when the checksums select the built paths', async () => {
		const fixture = await writeMixedReceipt();
		const invocations: string[][] = [];
		await writeFile(
			fixture.checksumsFile,
			`${'1'.repeat(64)}  ${path.basename(appPath)}\n`
		);

		await attestAttachAction(options(fixture), {}, recordingReporter([]), {
			runCupboard: (_binaryPath, arguments_) => {
				invocations.push([...arguments_]);

				return Promise.resolve(attachedResults([appPath]));
			}
		});

		expect(invocations).toStrictEqual([
			[
				'--no-colour',
				'attest',
				'attach',
				'https://cache.example.workers.dev/t/acme',
				appPath,
				'--github-oidc',
				'--attestation',
				'/tmp/bundle.sigstore.json'
			]
		]);
	});

	it('attaches newly published store-held and reference subjects', async () => {
		const fixture = await writeMixedReceipt();
		const heldPath = '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-held';
		const republishedPath =
			'/nix/store/5123456789abcdfghijklmnpqrsvwxyz-republished';
		const invocations: string[][] = [];
		await writeFile(
			fixture.checksumsFile,
			`${'3'.repeat(64)}  ${path.basename(heldPath)}\n${'4'.repeat(64)}  ${path.basename(republishedPath)}\n`
		);

		await attestAttachAction(options(fixture), {}, recordingReporter([]), {
			inspectCommandOptions: fileCapableCommandOptions,
			runCupboard: async (_binaryPath, arguments_) => {
				invocations.push([
					...(await expandAttachManifestArguments(arguments_))
				]);
				return attachedResults([heldPath, republishedPath]);
			}
		});

		expect(invocations).toStrictEqual([
			[
				'--no-colour',
				'attest',
				'attach',
				'https://cache.example.workers.dev/t/acme',
				heldPath,
				republishedPath,
				'--github-oidc',
				'--attestation',
				'/tmp/bundle.sigstore.json'
			]
		]);
	});

	it.each([
		{
			name: 'a changed copied digest',
			checksums: `${'f'.repeat(64)}  ${path.basename(runtimePath)}\n`,
			expected: { storePaths: [runtimePath], unexpectedNames: [] }
		},
		{
			name: 'a changed store-held digest',
			checksums: `${'f'.repeat(64)}  4123456789abcdfghijklmnpqrsvwxyz-held\n`,
			expected: {
				storePaths: ['/nix/store/4123456789abcdfghijklmnpqrsvwxyz-held'],
				unexpectedNames: []
			}
		}
	])('rejects $name in selected checksums', async ({ checksums, expected }) => {
		const fixture = await writeMixedReceipt();
		await writeFile(fixture.checksumsFile, checksums);

		await expect(
			attestAttachAction(options(fixture), {}, recordingReporter([]))
		).rejects.toStrictEqual(
			expect.objectContaining({
				name: 'AttestationChecksumsMismatchError',
				...expected
			})
		);
	});

	it('rejects checksums that omit an eligible receipt subject', async () => {
		const fixture = await writeReceipt([appPath, runtimePath]);
		await writeFile(
			fixture.checksumsFile,
			`${'1'.repeat(64)}  ${path.basename(appPath)}\n`
		);

		await expect(
			attestAttachAction(options(fixture), {}, recordingReporter([]), {
				runCupboard: () => {
					throw new Error('must not attach a partial subject set');
				}
			})
		).rejects.toStrictEqual(
			expect.objectContaining({
				name: 'AttestationChecksumsMismatchError',
				storePaths: [runtimePath]
			})
		);
	});

	it('rejects a changed checksum for an eligible receipt subject', async () => {
		const fixture = await writeReceipt([appPath]);
		await writeFile(
			fixture.checksumsFile,
			`${'f'.repeat(64)}  ${path.basename(appPath)}\n`
		);

		await expect(
			attestAttachAction(options(fixture), {}, recordingReporter([]))
		).rejects.toBeInstanceOf(AttestationChecksumsMismatchError);
	});

	it('rejects checksums that list subjects outside the eligible receipt', async () => {
		const fixture = await writeReceipt([appPath]);
		await writeFile(
			fixture.checksumsFile,
			`${'1'.repeat(64)}  ${path.basename(appPath)}\n${'2'.repeat(64)}  unrelated-output\n`
		);

		await expect(
			attestAttachAction(options(fixture), {}, recordingReporter([]))
		).rejects.toStrictEqual(
			expect.objectContaining({
				name: 'AttestationChecksumsMismatchError',
				unexpectedNames: ['unrelated-output']
			})
		);
	});

	it('warns and skips cupboard for a receipt with no subjects', async () => {
		const fixture = await writeReceipt([]);
		const warnings: string[] = [];
		const invocations: unknown[] = [];

		await attestAttachAction(
			options(fixture),
			{},
			recordingReporter(warnings),
			{
				runCupboard: (binaryPath, arguments_) => {
					invocations.push({ binaryPath, arguments: arguments_ });

					return Promise.resolve([]);
				}
			}
		);

		expect({ invocations, warnings }).toStrictEqual({
			invocations: [],
			warnings: [
				'The checksums file selects no receipt subjects; skipping attestation attachment'
			]
		});
	});

	it('fails when the CLI does not attach every signed subject', async () => {
		const fixture = await writeReceipt([appPath, runtimePath]);

		await expect(
			attestAttachAction(options(fixture), {}, recordingReporter([]), {
				inspectCommandOptions: fileCapableCommandOptions,
				runCupboard: () =>
					Promise.resolve([
						{
							kind: 'attestation-attach-summary',
							data: {
								attached: 1,
								reused: 0,
								unservable: 1,
								uploadedBytes: 1,
								paths: [
									{
										storePathHash: StorePath.hash(appPath),
										storePath: appPath,
										outcome: 'attached'
									},
									{
										storePathHash: StorePath.hash(runtimePath),
										storePath: runtimePath,
										outcome: 'unservable'
									}
								]
							}
						}
					])
			})
		).rejects.toThrow(
			`Attestation attachment was incomplete for: ${runtimePath}`
		);
	});

	it('fails when the CLI emits no attachment result', async () => {
		const fixture = await writeReceipt([appPath]);

		await expect(
			attestAttachAction(options(fixture), {}, recordingReporter([]), {
				runCupboard: () => Promise.resolve([])
			})
		).rejects.toThrow(
			'The installed cupboard emitted no attestation attachment result'
		);
	});
});
