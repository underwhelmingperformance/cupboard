import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Reporter } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { InvalidInputError, MissingInputError } from '../errors.ts';

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
		bundle: ['/tmp/bundle.sigstore.json'],
		...overrides
	};
}

async function writeReceipt(paths: readonly string[]): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attach-'));
	const receiptFile = path.join(directory, 'receipt.json');
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

	return receiptFile;
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
});

describe('attestAttachAction', () => {
	it('shells the installed cupboard with the receipt paths and bundle', async () => {
		const receiptFile = await writeReceipt([appPath, runtimePath]);
		const invocations: {
			binaryPath: string;
			arguments: readonly string[];
		}[] = [];

		await attestAttachAction(
			options({ receiptFile, readUser: 'reader', readPassword: 'secret' }),
			{},
			recordingReporter([]),
			{
				runCupboard: (binaryPath, arguments_) => {
					invocations.push({ binaryPath, arguments: arguments_ });

					return Promise.resolve([]);
				}
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
				]
			}
		]);
	});

	it('warns and runs nothing for a receipt with no paths', async () => {
		const receiptFile = await writeReceipt([]);
		const warnings: string[] = [];
		const invocations: unknown[] = [];

		await attestAttachAction(
			options({ receiptFile }),
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
});
