import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import {
	InvalidVerifierThresholdError,
	parseVerifierThreshold,
	registerAttestCommands
} from './attest.ts';

describe('parseVerifierThreshold', () => {
	it.each([
		{ source: '0', expected: 0 },
		{ source: '1', expected: 1 },
		{
			source: String(Number.MAX_SAFE_INTEGER),
			expected: Number.MAX_SAFE_INTEGER
		}
	])('accepts $source', ({ source, expected }) => {
		expect(parseVerifierThreshold('--tlog-threshold')(source)).toBe(expected);
	});

	it.each(['', '-1', '+1', '1.5', '1log', 'Infinity'])(
		'rejects %s',
		(source) => {
			expect(() => parseVerifierThreshold('--tlog-threshold')(source)).toThrow(
				InvalidVerifierThresholdError
			);
		}
	);

	it('rejects unsafe integers', () => {
		expect(() =>
			parseVerifierThreshold('--tlog-threshold')('9007199254740992')
		).toThrow(InvalidVerifierThresholdError);
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

		await expect(
			program.parseAsync(
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
			)
		).rejects.toThrow(
			"required option '--predicate-type <type>' not specified"
		);
	});
});
