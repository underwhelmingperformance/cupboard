import { Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	AttestAttachBundleRequiredError,
	ReadCredentialPairError
} from '../errors.ts';

import {
	InvalidVerifierThresholdError,
	parseVerifierThreshold,
	registerAttestCommands,
	trustRows
} from './attest.ts';

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

describe('attest verify command', () => {
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
