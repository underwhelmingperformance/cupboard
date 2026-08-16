import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { StorePath } from '@cupboard/nix-store/store-path';
import type { Reporter } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	AttestationChecksumsMismatchError,
	InvalidInputError,
	MissingInputError
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
			cache: 'pr-1',
			audience: 'https://audience.test',
			readUser: 'reader',
			readPassword: 'secret',
			receiptFile: '/tmp/receipt.json',
			checksumsFile: '/tmp/subjects.txt',
			bundles: ['/tmp/bundle.sigstore.json']
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
			expected: InvalidInputError
		}
	])('requires $name', ({ overrides, expected }) => {
		let thrown: unknown;

		try {
			resolveAttestAttachInputs(options(overrides));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(expected);
	});

	it.each([
		{ name: 'read-user alone', overrides: { readUser: 'reader' } },
		{ name: 'read-password alone', overrides: { readPassword: 'secret' } }
	])('refuses $name', ({ overrides }) => {
		expect(() => resolveAttestAttachInputs(options(overrides))).toThrow(
			InvalidInputError
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

		expect(attestAttachArguments(inputs, [appPath, runtimePath])).toStrictEqual(
			[
				'--no-colour',
				'attest',
				'attach',
				'https://cache.example.workers.dev/t/acme',
				appPath,
				runtimePath,
				'--github-oidc',
				'--audience',
				'https://audience.test',
				'--cache',
				'pr-1',
				'--read-user',
				'reader',
				'--read-password',
				'secret',
				'--attestation',
				'/tmp/bundle.sigstore.json'
			]
		);
	});

	it('omits the audience and cache flags when not provided', () => {
		const inputs = resolveAttestAttachInputs(options());

		expect(attestAttachArguments(inputs, [appPath])).toStrictEqual([
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

	// The attest action signs the same subjects twice, and the workflow passes
	// both bundles on separate lines of one input.
	it('attaches the build-provenance and build-origin bundles of one run', () => {
		const inputs = resolveAttestAttachInputs(
			options({
				bundle: [
					'/tmp/provenance.sigstore.json',
					'/tmp/build-origin.sigstore.json'
				]
			})
		);

		expect(attestAttachArguments(inputs, [appPath])).toStrictEqual([
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
	it('shells the installed cupboard with the receipt paths and bundle', async () => {
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
				runCupboard: (binaryPath, arguments_, _environment, dependencies) => {
					invocations.push({
						binaryPath,
						arguments: arguments_,
						dependencies
					});

					return Promise.resolve(attachedResults([appPath, runtimePath]));
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
				runCupboard: (_binaryPath, arguments_) => {
					invocations.push([...arguments_]);

					return Promise.resolve(attachedResults([appPath, runtimePath]));
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

	it('rejects checksums that name subjects outside the eligible receipt', async () => {
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

	it('warns and runs nothing for a receipt with no paths', async () => {
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

		expect({ invocations, warningCount: warnings.length }).toStrictEqual({
			invocations: [],
			warningCount: 1
		});
	});

	it('fails when the CLI does not attach every signed subject', async () => {
		const fixture = await writeReceipt([appPath, runtimePath]);

		await expect(
			attestAttachAction(options(fixture), {}, recordingReporter([]), {
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

	it('fails when the CLI records no attachment result', async () => {
		const fixture = await writeReceipt([appPath]);

		await expect(
			attestAttachAction(options(fixture), {}, recordingReporter([]), {
				runCupboard: () => Promise.resolve([])
			})
		).rejects.toThrow(
			'The installed cupboard recorded no attestation attachment result'
		);
	});
});
