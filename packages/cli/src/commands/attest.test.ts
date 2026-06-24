import { Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	InvalidVerifierThresholdError,
	parseVerifierThreshold,
	registerAttestCommands
} from './attest.ts';

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

describe('parseVerifierThreshold', () => {
	it.each([
		{ source: '1', expected: 1 },
		{
			source: String(Number.MAX_SAFE_INTEGER),
			expected: Number.MAX_SAFE_INTEGER
		}
	])('accepts $source', ({ source, expected }) => {
		expect(parseVerifierThreshold('--tlog-threshold')(source)).toBe(expected);
	});

	it.each(['', '0', '-1', '+1', '1.5', '1log', 'Infinity'])(
		'rejects %s',
		(source) => {
			const error = thrownBy(() =>
				parseVerifierThreshold('--tlog-threshold')(source)
			);

			expect(error).toBeInstanceOf(InvalidVerifierThresholdError);

			if (error instanceof InvalidVerifierThresholdError) {
				expect({ option: error.option, value: error.value }).toStrictEqual({
					option: '--tlog-threshold',
					value: source
				});
			}
		}
	);

	it('rejects unsafe integers', () => {
		const error = thrownBy(() =>
			parseVerifierThreshold('--tlog-threshold')('9007199254740992')
		);

		expect(error).toBeInstanceOf(InvalidVerifierThresholdError);

		if (error instanceof InvalidVerifierThresholdError) {
			expect({ option: error.option, value: error.value }).toStrictEqual({
				option: '--tlog-threshold',
				value: '9007199254740992'
			});
		}
	});
});

describe('attest verify command', () => {
	it('requires a predicate type policy', async () => {
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
