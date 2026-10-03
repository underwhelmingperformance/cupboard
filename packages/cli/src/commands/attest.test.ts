import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { IneffectiveCtlogThresholdError } from '@cupboard/shared/sigstore';
import { Command, CommanderError } from 'commander';
import { describe, expect, it, onTestFinished } from 'vitest';

import { buildProgram, cliExitCode } from '../cli.ts';
import {
	AttestAttachBundleRequiredError,
	ReadCredentialPairError
} from '../errors.ts';

import {
	appendPathFile,
	InvalidVerifierThresholdError,
	parseVerifierThreshold,
	registerAttestCommands,
	trustRows
} from './attest.ts';

const attachmentStorePath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';

function attachmentBundle(padding?: string): string {
	const statement = {
		_type: 'https://in-toto.io/Statement/v1',
		subject: [
			{ name: attachmentStorePath, digest: { sha256: 'a'.repeat(64) } }
		],
		predicateType: 'https://slsa.dev/provenance/v1',
		predicate: {}
	};
	const payload = Buffer.from(JSON.stringify(statement)).toString('base64');

	return JSON.stringify({
		padding,
		dsseEnvelope: {
			payloadType: 'application/vnd.in-toto+json',
			payload
		}
	});
}

describe('attachment input validation', () => {
	it('returns usage status and a file diagnostic from the actual CLI', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attach-'));
		const pathsFile = path.join(directory, 'missing-paths.txt');
		try {
			const child = spawn(
				process.execPath,
				[
					'--experimental-transform-types',
					'--disable-warning=ExperimentalWarning',
					path.resolve(import.meta.dirname, '../main.ts'),
					'--output-mode',
					'json',
					'attest',
					'attach',
					'http://127.0.0.1:9/t/acme',
					'--paths-file',
					pathsFile,
					'--bundle',
					path.join(directory, 'bundle.json')
				],
				{
					env: { ...process.env, CI: 'true', XDG_CONFIG_HOME: directory }
				}
			);
			onTestFinished(async () => {
				if (child.exitCode !== null || child.signalCode !== null) {
					return;
				}
				const closed = new Promise<void>((resolve) => {
					child.once('close', () => {
						resolve();
					});
				});
				child.kill('SIGKILL');
				await closed;
			});
			let stdout = '';
			let stderr = '';
			child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
				stderr += chunk;
			});
			const status = await new Promise<number | null>((resolve, reject) => {
				child.once('error', reject);
				child.once('close', resolve);
			});
			const diagnostic: unknown = JSON.parse(stderr.trim());

			expect({
				status,
				stdout,
				diagnostic
			}).toStrictEqual({
				status: 2,
				stdout: '',
				diagnostic: {
					event: 'error',
					name: 'AttestAttachInputError',
					message: `Cannot read --paths-file ${pathsFile}. Check that the file exists and is readable.`,
					causes: [
						`Error: ENOENT: no such file or directory, open '${pathsFile}'`
					]
				}
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 30_000);

	it.each([
		{ kind: 'path-file-cache-name' },
		{ kind: 'path-file-invalid-later-line' },
		{ kind: 'invalid-positional' },
		{ kind: 'missing-path-file' },
		{ kind: 'missing-bundle-file' },
		{ kind: 'invalid-bundle-file' },
		{ kind: 'oversized-bundle-file' },
		{ kind: 'missing-bundle-manifest' }
	])('rejects $kind before authentication', async ({ kind }) => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attach-'));
		const pathsFile = path.join(directory, 'paths.txt');
		const bundleFile = path.join(directory, 'bundle.json');
		const manifest = path.join(directory, 'bundles.txt');
		const authenticated: unknown[] = [];
		const program = new Command().exitOverride();
		program.configureOutput({
			writeErr() {
				return;
			},
			writeOut() {
				return;
			}
		});
		registerAttestCommands(
			program,
			{},
			{
				authenticate: (client) => {
					authenticated.push(client.cache);
					throw new Error('Authentication started');
				}
			}
		);

		try {
			await writeFile(bundleFile, attachmentBundle());
			await writeFile(pathsFile, `${attachmentStorePath}\n`);
			let positionals: string[] = [];
			let flags = ['--paths-file', pathsFile, '--bundle', bundleFile];
			let expectedMessage: string;
			switch (kind) {
				case 'path-file-cache-name': {
					await writeFile(pathsFile, 'builds\n');
					expectedMessage = `Invalid store path 'builds' in --paths-file ${pathsFile}, line 1. Pass an absolute store path or a local link to one.`;
					break;
				}
				case 'path-file-invalid-later-line': {
					await writeFile(
						pathsFile,
						`\r\n${attachmentStorePath}\r\ninvalid\r\n`
					);
					expectedMessage = `Invalid store path 'invalid' in --paths-file ${pathsFile}, line 3. Pass an absolute store path or a local link to one.`;
					break;
				}
				case 'invalid-positional': {
					positionals = ['builds', 'invalid'];
					expectedMessage =
						"Invalid store path 'invalid' in the command arguments. Pass an absolute store path or a local link to one.";
					break;
				}
				case 'missing-path-file': {
					flags = [
						'--paths-file',
						`${pathsFile}.missing`,
						'--bundle',
						bundleFile
					];
					expectedMessage = `Cannot read --paths-file ${pathsFile}.missing. Check that the file exists and is readable.`;
					break;
				}
				case 'missing-bundle-file': {
					flags = [
						'--paths-file',
						pathsFile,
						'--bundle',
						`${bundleFile}.missing`
					];
					expectedMessage = `Cannot read bundle ${bundleFile}.missing. Check that the file exists and is readable.`;
					break;
				}
				case 'invalid-bundle-file': {
					await writeFile(bundleFile, 'not JSON');
					expectedMessage = `Invalid attestation bundle ${bundleFile}: bundle is not JSON`;
					break;
				}
				case 'oversized-bundle-file': {
					await writeFile(
						bundleFile,
						attachmentBundle('a'.repeat(1024 * 1024))
					);
					expectedMessage = `Bundle ${bundleFile} exceeds the maximum size of 1048576 bytes.`;
					break;
				}
				default: {
					flags = ['--paths-file', pathsFile, '--bundles-file', manifest];
					expectedMessage = `Cannot read --bundles-file ${manifest}. Check that the file exists and is readable.`;
				}
			}

			let failure: unknown;
			try {
				await program.parseAsync(
					[
						'attest',
						'attach',
						'https://cupboard.example.workers.dev/t/acme',
						...positionals,
						...flags
					],
					{ from: 'user' }
				);
			} catch (error) {
				failure = error;
			}

			expect({
				name: failure instanceof Error ? failure.name : undefined,
				message: failure instanceof Error ? failure.message : undefined,
				status: cliExitCode(failure, 130),
				authenticated
			}).toStrictEqual({
				name: 'AttestAttachInputError',
				message: expectedMessage,
				status: 2,
				authenticated: []
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('keeps valid file entries as default-cache payload', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attach-'));
		const pathsFile = path.join(directory, 'paths.txt');
		const bundleFile = path.join(directory, 'bundle.json');
		const authenticated: unknown[] = [];
		const refused = new Error('Authentication started');
		const program = new Command().exitOverride();
		registerAttestCommands(
			program,
			{},
			{
				authenticate: (client) => {
					authenticated.push(client.cache);
					throw refused;
				}
			}
		);

		try {
			await writeFile(bundleFile, attachmentBundle());
			await writeFile(pathsFile, `${attachmentStorePath}\n`);
			let failure: unknown;
			try {
				await program.parseAsync(
					[
						'attest',
						'attach',
						'https://cupboard.example.workers.dev/t/acme',
						'--paths-file',
						pathsFile,
						'--bundle',
						bundleFile
					],
					{ from: 'user' }
				);
			} catch (error) {
				failure = error;
			}

			expect({ failure, authenticated }).toStrictEqual({
				failure: refused,
				authenticated: [{ kind: 'default' }]
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe('appendPathFile', () => {
	it('combines direct bundle paths with a manifest without an argument-size limit', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-bundles-'));
		const manifest = path.join(directory, 'bundles.txt');
		const paths = Array.from({ length: 1600 }, (_, index) =>
			path.join(directory, `${String(index)}.sigstore.json`)
		);

		try {
			await writeFile(manifest, `\n${paths.join('\n')}\n`);
			expect(
				await appendPathFile(['direct.sigstore.json'], manifest)
			).toStrictEqual(['direct.sigstore.json', ...paths]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

interface VerifyThresholds {
	readonly tlogThreshold?: number;
	readonly ctlogThreshold?: number;
	readonly timestampThreshold?: number;
}

function silentProgram(): Command {
	const program = new Command();
	program.exitOverride();
	program.configureOutput({
		writeErr() {
			return;
		},
		writeOut() {
			return;
		}
	});
	registerAttestCommands(program);

	return program;
}

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

function thresholdFailure(error: unknown): unknown {
	return error instanceof InvalidVerifierThresholdError
		? {
				name: error.name,
				option: error.option,
				value: error.value,
				minimum: error.minimum
			}
		: error;
}

describe('bundle option aliases', () => {
	it.each([
		{ command: 'push', flags: ['--bundle', 'a.json'], expected: ['a.json'] },
		{
			command: 'push',
			flags: ['--attestation', 'a.json', '--bundle', 'b.json'],
			expected: ['a.json', 'b.json']
		},
		{ command: 'attach', flags: ['--bundle', 'a.json'], expected: ['a.json'] },
		{
			command: 'attach',
			flags: ['--attestation', 'a.json', '--bundle', 'b.json'],
			expected: ['a.json', 'b.json']
		},
		{
			command: 'attach',
			flags: ['--bundles-file', 'bundles.txt'],
			expected: []
		},
		{
			command: 'attach',
			flags: [
				'--attestations-file',
				'bundles.txt',
				'--bundles-file',
				'bundles.txt'
			],
			expected: []
		}
	])(
		'maps $command $flags to the existing parsed fields',
		async ({ command, flags, expected }) => {
			const program = buildProgram().configureOutput({
				writeErr() {
					return;
				}
			});
			const action =
				command === 'push'
					? program.commands.find((entry) => entry.name() === 'push')
					: program.commands
							.find((entry) => entry.name() === 'attest')
							?.commands.find((entry) => entry.name() === 'attach');
			if (action === undefined) {
				throw new Error('command is not registered');
			}
			const defaults = { ...action.opts() };
			action.action(() => Promise.resolve());
			await program.parseAsync(
				[
					...(command === 'push' ? ['push'] : ['attest', 'attach']),
					'https://cupboard.example.workers.dev/t/acme',
					...flags
				],
				{ from: 'user' }
			);
			expect(action.opts()).toStrictEqual({
				...defaults,
				...(command === 'push' && { attest: true, retain: true, wait: true }),
				attestation: expected,
				...(flags.includes('--bundles-file') && {
					attestationsFile: 'bundles.txt'
				})
			});
		}
	);

	it.each([
		['--attestations-file', 'a.txt', '--bundles-file', 'b.txt'],
		['--bundles-file', 'a.txt', '--attestations-file', 'b.txt']
	])('rejects conflicting manifests: %s', async (...flags) => {
		const program = silentProgram();
		let error: unknown;
		try {
			await program.parseAsync(
				[
					'attest',
					'attach',
					'https://cupboard.example.workers.dev/t/acme',
					...flags
				],
				{ from: 'user' }
			);
		} catch (error_) {
			error = error_;
		}
		expect({
			message: error instanceof Error ? error.message : undefined,
			exitCode: cliExitCode(error, 130)
		}).toStrictEqual({
			message:
				"error: option '--bundles-file, --attestations-file <path>' argument 'b.txt' is invalid. Pass one bundle manifest with --bundles-file or --attestations-file; conflicting paths were supplied.",
			exitCode: 2
		});
	});
});

describe('parseVerifierThreshold', () => {
	it.each([
		{ source: '1', expected: 1 },
		{
			source: String(Number.MAX_SAFE_INTEGER),
			expected: Number.MAX_SAFE_INTEGER
		}
	])('accepts $source', ({ source, expected }) => {
		expect(parseVerifierThreshold('--timestamp-threshold', 1)(source)).toBe(
			expected
		);
	});

	it.each(['', '0', '-1', '+1', '1.5', '1log', 'Infinity', '9007199254740992'])(
		'rejects %s',
		(source) => {
			const error = thrownBy(() =>
				parseVerifierThreshold('--timestamp-threshold', 1)(source)
			);

			expect(thresholdFailure(error)).toStrictEqual({
				name: 'InvalidVerifierThresholdError',
				option: '--timestamp-threshold',
				value: source,
				minimum: 1
			});
		}
	);
});

describe('attest attach command', () => {
	it('reads path files alongside positional paths', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-attest-'));
		const pathsFile = path.join(directory, 'paths.txt');
		try {
			await writeFile(pathsFile, '\n/nix/store/first\r\n/nix/store/second\n\n');

			expect(
				await appendPathFile(['/nix/store/positional'], pathsFile)
			).toStrictEqual([
				'/nix/store/positional',
				'/nix/store/first',
				'/nix/store/second'
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('requires at least one --attestation bundle before authenticating', async () => {
		const program = silentProgram();

		let result: unknown;
		try {
			await program.parseAsync(
				[
					'attest',
					'attach',
					'https://cache.example.workers.dev/t/acme',
					'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
				],
				{ from: 'user' }
			);
			result = { kind: 'parsed' as const };
		} catch (error: unknown) {
			result = error;
		}

		expect(result).toBeInstanceOf(AttestAttachBundleRequiredError);
	});

	it('refuses an incomplete private-read credential before authenticating', async () => {
		const program = silentProgram();

		await expect(
			program.parseAsync(
				[
					'attest',
					'attach',
					'https://cache.example.workers.dev/t/acme',
					'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
					'--read-user',
					'reader',
					'--attestation',
					'bundle.json'
				],
				{ from: 'user' }
			)
		).rejects.toBeInstanceOf(ReadCredentialPairError);
	});
});

describe('attest status command', () => {
	it('classifies an unreadable path file as an argument error before authentication', async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-status-'));
		try {
			let failure: unknown;
			try {
				await silentProgram().parseAsync(
					[
						'attest',
						'status',
						'https://cache.example.workers.dev/t/acme',
						'--paths-file',
						path.join(directory, 'missing'),
						'--github-oidc'
					],
					{ from: 'user' }
				);
			} catch (error) {
				failure = error;
			}
			expect({
				name: failure instanceof Error ? failure.name : undefined,
				status: cliExitCode(failure, 130)
			}).toStrictEqual({ name: 'StatusOptionsError', status: 2 });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('validates paths before read authentication', async () => {
		const program = silentProgram();
		let failure: unknown;
		try {
			await program.parseAsync(
				[
					'attest',
					'status',
					'https://cache.example.workers.dev/t/acme',
					'invalid-path',
					'--read-user',
					'alice'
				],
				{ from: 'user' }
			);
		} catch (error) {
			failure = error;
		}
		expect({
			name: failure instanceof Error ? failure.name : undefined,
			message: failure instanceof Error ? failure.message : undefined,
			status: cliExitCode(failure, 130)
		}).toStrictEqual({
			name: 'StatusOptionsError',
			message: 'Invalid store path: invalid-path',
			status: 2
		});
	});
});

describe('attest verify command', () => {
	it.each([
		{
			args: [
				'missing.sigstore.json',
				'--nar-hash',
				'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347',
				'--certificate-oidc-issuer',
				'https://issuer.test'
			]
		},
		{
			args: [
				'missing.sigstore.json',
				'--nar-hash',
				'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347',
				'--certificate-identity-regex',
				'[',
				'--certificate-oidc-issuer',
				'https://issuer.test'
			]
		},
		{
			args: [
				'--url',
				'http://127.0.0.1:9/t/acme',
				'--store-path-hash',
				'0123456789abcdfghijklmnpqrsvwxyz',
				'--certificate-identity',
				'alice@example.test',
				'--certificate-oidc-issuer',
				'https://issuer.test',
				'--trusted-public-key',
				'example:invalid',
				'--trust-cache-pubkey'
			]
		}
	])(
		'returns usage status from the actual CLI for $args',
		async ({ args }) => {
			const child = spawn(
				process.execPath,
				[
					'--experimental-transform-types',
					'--disable-warning=ExperimentalWarning',
					path.resolve(import.meta.dirname, '../main.ts'),
					'--output-mode',
					'json',
					'attest',
					'verify',
					'--predicate-type',
					'https://slsa.dev/provenance/v1',
					...args
				],
				{ env: { ...process.env, CI: 'true' } }
			);
			onTestFinished(async () => {
				if (child.exitCode !== null || child.signalCode !== null) {
					return;
				}
				const closed = new Promise<void>((resolve) => {
					child.once('close', () => {
						resolve();
					});
				});
				child.kill('SIGKILL');
				await closed;
			});
			let stdout = '';
			child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.resume();
			const status = await new Promise<number | null>((resolve, reject) => {
				child.once('error', reject);
				child.once('close', resolve);
			});

			expect({ status, stdout }).toStrictEqual({ status: 2, stdout: '' });
		},
		30_000
	);

	it.each([
		{
			flags: ['--certificate-oidc-issuer', 'https://issuer.test'],
			name: 'CertificateIdentityModeError',
			message:
				'Pass exactly one of --certificate-identity or --certificate-identity-regex'
		},
		{
			flags: ['--certificate-identity', 'alice@example.test'],
			name: 'CertificateIssuerModeError',
			message:
				'Pass exactly one of --certificate-oidc-issuer or --certificate-oidc-issuer-regex'
		},
		{
			flags: [
				'--certificate-identity',
				'alice@example.test',
				'--certificate-identity-regex',
				'alice@.*',
				'--certificate-oidc-issuer',
				'https://issuer.test'
			],
			name: 'CertificateIdentityModeError',
			message:
				'Pass exactly one of --certificate-identity or --certificate-identity-regex'
		},
		{
			flags: [
				'--certificate-identity',
				'alice@example.test',
				'--certificate-oidc-issuer',
				'https://issuer.test',
				'--certificate-oidc-issuer-regex',
				'issuer'
			],
			name: 'CertificateIssuerModeError',
			message:
				'Pass exactly one of --certificate-oidc-issuer or --certificate-oidc-issuer-regex'
		},
		{
			flags: [
				'--certificate-identity-regex',
				'[',
				'--certificate-oidc-issuer',
				'https://issuer.test'
			],
			name: 'CertificatePatternError',
			message: 'Invalid --certificate-identity-regex regular expression: ['
		},
		{
			flags: [
				'--certificate-identity',
				'alice@example.test',
				'--certificate-oidc-issuer-regex',
				'['
			],
			name: 'CertificatePatternError',
			message: 'Invalid --certificate-oidc-issuer-regex regular expression: ['
		}
	])('classifies invalid signer policy $flags as usage', async (scenario) => {
		let failure: unknown;
		try {
			await silentProgram().parseAsync(
				[
					'attest',
					'verify',
					'missing.sigstore.json',
					'--nar-hash',
					'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347',
					'--predicate-type',
					'https://slsa.dev/provenance/v1',
					...scenario.flags
				],
				{ from: 'user' }
			);
		} catch (error) {
			failure = error;
		}

		expect({
			name: failure instanceof Error ? failure.name : undefined,
			message: failure instanceof Error ? failure.message : undefined,
			status: cliExitCode(failure, 130)
		}).toStrictEqual({
			name: scenario.name,
			message: scenario.message,
			status: 2
		});
	});

	it('requires a predicate type policy', async () => {
		const program = silentProgram();

		let result: unknown;
		try {
			await program.parseAsync(
				[
					'attest',
					'verify',
					'bundle.sigstore.json',
					'--nar-hash',
					'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347',
					'--certificate-identity',
					'alice@example.test',
					'--certificate-oidc-issuer',
					'https://issuer.test'
				],
				{ from: 'user' }
			);
			result = { kind: 'parsed' as const };
		} catch (error_: unknown) {
			result = error_;
		}

		expect(result).toBeInstanceOf(CommanderError);

		if (result instanceof CommanderError) {
			expect({
				name: result.name,
				code: result.code,
				exitCode: result.exitCode
			}).toStrictEqual({
				name: 'CommanderError',
				code: 'commander.missingMandatoryOptionValue',
				exitCode: 1
			});
		}
	});
});

describe('attest verify without --trusted-root', () => {
	it.each([
		{
			mode: 'remote',
			arguments_: [
				'--url',
				'https://cache.example.workers.dev/t/acme',
				'--store-path-hash',
				'0123456789abcdfghijklmnpqrsvwxyz'
			]
		},
		{
			mode: 'local',
			arguments_: [
				'bundle.sigstore.json',
				'--nar-hash',
				'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347'
			]
		}
	])(
		'rejects --ctlog-threshold 0 in $mode mode before reading a bundle',
		async ({ arguments_ }) => {
			let refusal: unknown;

			try {
				await silentProgram().parseAsync(
					[
						'attest',
						'verify',
						...arguments_,
						'--predicate-type',
						'https://slsa.dev/provenance/v1',
						'--ctlog-threshold',
						'0'
					],
					{ from: 'user' }
				);
			} catch (error) {
				refusal = error;
			}

			expect(
				refusal instanceof IneffectiveCtlogThresholdError
					? { name: refusal.name, trustedRoot: refusal.trustedRoot }
					: refusal
			).toStrictEqual({
				name: 'IneffectiveCtlogThresholdError',
				trustedRoot: undefined
			});
		}
	);
});

describe('attest verify thresholds', () => {
	class StoppedBeforeAction extends Error {}

	async function parseThreshold(
		option: string,
		value: string
	): Promise<unknown> {
		const program = silentProgram();
		let thresholds: unknown;

		program.hook('preAction', (_program, action) => {
			const { tlogThreshold, ctlogThreshold, timestampThreshold } =
				action.opts<VerifyThresholds>();
			thresholds = { tlogThreshold, ctlogThreshold, timestampThreshold };

			throw new StoppedBeforeAction();
		});

		try {
			await program.parseAsync(
				[
					'attest',
					'verify',
					'bundle.sigstore.json',
					'--nar-hash',
					'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347',
					'--predicate-type',
					'https://slsa.dev/provenance/v1',
					option,
					value
				],
				{ from: 'user' }
			);
		} catch (error) {
			if (error instanceof InvalidVerifierThresholdError) {
				return thresholdFailure(error);
			}

			if (!(error instanceof StoppedBeforeAction)) {
				throw error;
			}
		}

		return thresholds;
	}

	it.each([
		{
			option: '--tlog-threshold',
			expected: {
				tlogThreshold: 0,
				ctlogThreshold: undefined,
				timestampThreshold: undefined
			}
		},
		{
			option: '--ctlog-threshold',
			expected: {
				tlogThreshold: undefined,
				ctlogThreshold: 0,
				timestampThreshold: undefined
			}
		},
		{
			option: '--timestamp-threshold',
			expected: {
				name: 'InvalidVerifierThresholdError',
				option: '--timestamp-threshold',
				value: '0',
				minimum: 1
			}
		}
	])(
		'checks 0 against the minimum for $option',
		async ({ option, expected }) => {
			expect(await parseThreshold(option, '0')).toStrictEqual(expected);
		}
	);
});

describe('trustRows', () => {
	it.each([
		{
			name: 'the public-good root and no thresholds',
			options: {},
			trust: {
				tlogEntries: [],
				timestampCount: 1,
				acceptingRoot: { kind: 'public-good' },
				certificateTransparency: {
					signedCertificateTimestamps: 1,
					threshold: 1
				}
			},
			expected: [
				{ label: 'Trusted root', value: 'the public-good Sigstore root' },
				{ label: 'Transparency log', value: '0 log entries (threshold 1)' },
				{
					label: 'Certificate transparency',
					value: '1 signed certificate timestamp (threshold 1)'
				},
				{ label: 'Timestamps', value: '1 verified timestamp (threshold 1)' }
			]
		},
		{
			name: 'a trusted-root file and a bundle signed with a public key',
			options: {
				trustedRoot: 'github-trusted-roots.jsonl',
				tlogThreshold: 0,
				timestampThreshold: 2
			},
			trust: {
				tlogEntries: [],
				timestampCount: 2,
				acceptingRoot: { kind: 'file', position: 2, count: 2 }
			},
			expected: [
				{
					label: 'Trusted root',
					value: 'root 2 of 2 in github-trusted-roots.jsonl'
				},
				{ label: 'Transparency log', value: '0 log entries (threshold 0)' },
				{
					label: 'Timestamps',
					value: '2 verified timestamps (threshold 2)'
				}
			]
		}
	] satisfies readonly {
		readonly name: string;
		readonly options: Parameters<typeof trustRows>[1];
		readonly trust: Parameters<typeof trustRows>[0];
		readonly expected: unknown;
	}[])('reports the evidence for $name', ({ options, trust, expected }) => {
		expect(trustRows(trust, options)).toStrictEqual(expected);
	});
});
