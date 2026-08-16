import { describe, expect, it } from 'vitest';

import {
	buildEventSchema,
	buildReceiptSchema,
	targetOutcomeSchema
} from './build.ts';

const storePath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const outputPath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib';
const derivation = '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv';

describe('buildEventSchema', () => {
	it('accepts a hook event', () => {
		const event = {
			version: 1,
			invocationId: 'invocation-1',
			derivation,
			outputPaths: [storePath, outputPath]
		};

		expect(buildEventSchema.parse(event)).toStrictEqual(event);
	});

	it.each([
		{
			name: 'an unknown format version',
			value: {
				version: 2,
				invocationId: 'invocation-1',
				derivation,
				outputPaths: [storePath]
			}
		},
		{
			name: 'an empty invocation id',
			value: {
				version: 1,
				invocationId: '',
				derivation,
				outputPaths: [storePath]
			}
		},
		{
			name: 'a derivation that is not a .drv path',
			value: {
				version: 1,
				invocationId: 'invocation-1',
				derivation: storePath,
				outputPaths: [storePath]
			}
		},
		{
			name: 'no completed output paths',
			value: {
				version: 1,
				invocationId: 'invocation-1',
				derivation,
				outputPaths: []
			}
		},
		{
			name: 'an output path outside the store-path shape',
			value: {
				version: 1,
				invocationId: 'invocation-1',
				derivation,
				outputPaths: ['relative/path']
			}
		},
		{
			name: 'an unknown field',
			value: {
				version: 1,
				invocationId: 'invocation-1',
				derivation,
				outputPaths: [storePath],
				extra: true
			}
		}
	])('rejects $name', ({ value }) => {
		expect(buildEventSchema.safeParse(value).success).toBe(false);
	});
});

describe('targetOutcomeSchema', () => {
	it.each([
		{ outcome: 'built', value: { outcome: 'built', storePath } },
		{
			outcome: 'destination-served',
			value: { outcome: 'destination-served', storePath }
		},
		{
			outcome: 'published-by-reference',
			value: { outcome: 'published-by-reference', storePath }
		},
		{
			outcome: 'left-upstream',
			value: { outcome: 'left-upstream', storePath }
		},
		{
			outcome: 'failed',
			value: { outcome: 'failed', storePath, reason: 'upload' }
		},
		{ outcome: 'collected', value: { outcome: 'collected', storePath } }
	])('round-trips a $outcome outcome', ({ value }) => {
		expect(targetOutcomeSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'an unknown outcome',
			value: { outcome: 'skipped', storePath }
		},
		{
			name: 'a failure without a reason kind',
			value: { outcome: 'failed', storePath }
		},
		{
			name: 'a failure with an unknown reason kind',
			value: { outcome: 'failed', storePath, reason: 'weather' }
		},
		{
			name: 'a reason on a non-failure outcome',
			value: { outcome: 'built', storePath, reason: 'upload' }
		}
	])('rejects $name', ({ value }) => {
		expect(targetOutcomeSchema.safeParse(value).success).toBe(false);
	});
});

describe('buildReceiptSchema', () => {
	const subject = {
		storePath,
		narHash: 'aa'.repeat(32),
		derivation,
		attempt: 1,
		attemptId: 'one'
	};

	it('accepts a receipt carrying only what a bare build knows', () => {
		const receipt = {
			version: 2,
			paths: [storePath, outputPath],
			subjects: [subject]
		};

		expect(buildReceiptSchema.parse(receipt)).toStrictEqual(receipt);
	});

	it('accepts a receipt carrying every planned-run section', () => {
		const receipt = {
			version: 2,
			paths: [storePath, outputPath],
			subjects: [subject],
			outcomes: [
				{ outcome: 'built', storePath },
				{ outcome: 'left-upstream', storePath: outputPath }
			],
			planner: {
				willBuild: 1,
				willSubstitute: 2,
				unknown: 0,
				attached: 3,
				adopted: 1,
				leftUpstream: 1
			},
			substitutable: { downloadSize: 1024, narSize: 4096 },
			evaluationTimeMs: 250,
			childExitStatus: 0,
			terminalFailure: {
				kind: 'target-build',
				failedTargets: ['.#packages.x86_64-linux.optional']
			},
			uploaded: [storePath],
			failed: [],
			collected: [outputPath]
		};

		expect(buildReceiptSchema.parse(receipt)).toStrictEqual(receipt);
	});

	const provenancedSubject = {
		origin: 'built',
		storePath,
		narHash: 'aa'.repeat(32),
		derivation,
		buildStore: 'ssh-ng://builder.example',
		verification: 'build-store'
	};

	it('accepts a receipt whose subjects carry their provenance', () => {
		const receipt = {
			version: 3,
			paths: [storePath, outputPath],
			subjects: [
				provenancedSubject,
				{
					origin: 'built',
					...subject,
					buildStore: 'auto',
					machine: 'ssh://builder-1',
					verification: 'build-store'
				}
			],
			uploaded: [storePath]
		};

		expect(buildReceiptSchema.parse(receipt)).toStrictEqual(receipt);
	});

	it('accepts a receipt describing a path the run did not build', () => {
		const receipt = {
			version: 3,
			paths: [storePath, outputPath],
			subjects: [
				{
					origin: 'store-held',
					storePath,
					narHash: 'aa'.repeat(32),
					derivation,
					buildStore: 'auto'
				},
				{
					origin: 'copied',
					storePath: outputPath,
					narHash: 'bb'.repeat(32),
					signatures: ['cache.nixos.org-1:c2ln'],
					ca: 'fixed:r:sha256:0000000000000000000000000000000000000000000000000000',
					copiedFrom: ['https://cache.nixos.org']
				}
			],
			uploaded: [storePath]
		};

		expect(buildReceiptSchema.parse(receipt)).toStrictEqual(receipt);
	});

	it('accepts a copied subject the run holds no signature for', () => {
		const receipt = {
			version: 3,
			paths: [storePath],
			subjects: [
				{
					origin: 'copied',
					storePath,
					narHash: 'aa'.repeat(32),
					signatures: []
				}
			]
		};

		expect(buildReceiptSchema.parse(receipt)).toStrictEqual(receipt);
	});

	it('accepts both receipt versions through the same parser', () => {
		const version2 = { version: 2, paths: [storePath], subjects: [subject] };

		const version3 = {
			version: 3,
			paths: [storePath],
			subjects: [provenancedSubject]
		};

		expect([
			buildReceiptSchema.parse(version2),
			buildReceiptSchema.parse(version3)
		]).toStrictEqual([version2, version3]);
	});

	it('refuses a version-1 receipt', () => {
		const result = buildReceiptSchema.safeParse({
			version: 1,
			paths: [storePath],
			subjects: [subject]
		});

		expect(result.success).toBe(false);

		if (result.success) {
			return;
		}

		expect(
			result.error.issues.map((issue) => ({
				code: issue.code,
				path: issue.path
			}))
		).toStrictEqual([{ code: 'invalid_union', path: ['version'] }]);
	});

	it.each([
		{
			name: 'a path outside the store-path shape',
			value: { version: 2, paths: ['app'], subjects: [] }
		},
		{
			name: 'a subject attributed to attempt zero',
			value: {
				version: 2,
				paths: [storePath],
				subjects: [{ ...subject, attempt: 0 }]
			}
		},
		{
			name: 'a subject whose NAR hash is not sha256 hex',
			value: {
				version: 2,
				paths: [storePath],
				subjects: [{ ...subject, narHash: 'zz'.repeat(32) }]
			}
		},
		{
			name: 'a version 3 subject with no origin',
			value: {
				version: 3,
				paths: [storePath],
				subjects: [
					{
						storePath,
						narHash: 'aa'.repeat(32),
						derivation,
						buildStore: 'auto',
						verification: 'build-store'
					}
				]
			}
		},
		{
			name: 'a copied subject claiming a build store',
			value: {
				version: 3,
				paths: [storePath],
				subjects: [
					{
						origin: 'copied',
						storePath,
						narHash: 'aa'.repeat(32),
						signatures: [],
						buildStore: 'auto'
					}
				]
			}
		},
		{
			name: 'a copied subject whose list of sources is empty',
			value: {
				version: 3,
				paths: [storePath],
				subjects: [
					{
						origin: 'copied',
						storePath,
						narHash: 'aa'.repeat(32),
						signatures: [],
						copiedFrom: []
					}
				]
			}
		},
		{
			name: 'a fractional child exit status',
			value: {
				version: 2,
				paths: [storePath],
				subjects: [],
				childExitStatus: 1.5
			}
		},
		{
			name: 'a target failure without a failed request',
			value: {
				version: 3,
				paths: [],
				subjects: [],
				terminalFailure: { kind: 'target-build', failedTargets: [] }
			}
		},
		{
			name: 'a negative planner count',
			value: {
				version: 2,
				paths: [storePath],
				subjects: [],
				planner: {
					willBuild: -1,
					willSubstitute: 0,
					unknown: 0,
					attached: 0,
					adopted: 0,
					leftUpstream: 0
				}
			}
		},
		{
			name: 'an unknown field',
			value: { version: 2, paths: [storePath], subjects: [], extra: true }
		},
		{
			name: 'a version-2 subject in a version-3 receipt',
			value: { version: 3, paths: [storePath], subjects: [subject] }
		},
		{
			name: 'a version-3 subject in a version-2 receipt',
			value: {
				version: 2,
				paths: [storePath],
				subjects: [provenancedSubject]
			}
		},
		{
			name: 'a subject with no build store',
			value: {
				version: 3,
				paths: [storePath],
				subjects: [{ ...provenancedSubject, buildStore: '' }]
			}
		},
		{
			name: 'a subject with an unknown verification',
			value: {
				version: 3,
				paths: [storePath],
				subjects: [{ ...provenancedSubject, verification: 'trusted' }]
			}
		},
		{
			name: 'a subject naming an empty machine',
			value: {
				version: 3,
				paths: [storePath],
				subjects: [{ ...provenancedSubject, machine: '' }]
			}
		}
	])('rejects $name', ({ value }) => {
		expect(buildReceiptSchema.safeParse(value).success).toBe(false);
	});
});
