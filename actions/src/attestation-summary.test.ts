import { describe, expect, it } from 'vitest';

import { signingSummary } from './attestation-summary.ts';

describe('signing summary', () => {
	it('reports produced evidence, subject coverage and the repository attestation link', () => {
		const summary = signingSummary(
			'sigstore-default',
			[
				{
					file: '/tmp/bundle.json',
					subjects: [{ name: 'app', sha256: '1'.repeat(64) }],
					signed: {
						bundle: JSON.stringify({
							verificationMaterial: {
								tlogEntries: [{ logIndex: '9007199254740993' }]
							}
						}),
						evidence: { tlogEntryCount: 1, timestampCount: 0 },
						attestationId: '42'
					}
				}
			],
			{
				GITHUB_REPOSITORY: 'acme/app',
				GITHUB_SERVER_URL: 'https://github.example.test'
			}
		);
		expect(summary.data).toStrictEqual({
			subjectCount: 1,
			bundles: [
				{
					file: '/tmp/bundle.json',
					subjects: ['app'],
					instance: 'public-good',
					rekorIndices: ['9007199254740993'],
					timestampCount: 0,
					attestationUrl: 'https://github.example.test/acme/app/attestations/42'
				}
			]
		});
	});

	it('counts subjects once across statements and reports timestamps without a Rekor entry', () => {
		const bundle = {
			file: '/tmp/bundle.json',
			subjects: [{ name: 'app', sha256: '1'.repeat(64) }],
			signed: {
				bundle: '{}',
				evidence: { tlogEntryCount: 0, timestampCount: 1 }
			}
		};
		expect(
			signingSummary(
				'tsa-only',
				[bundle, { ...bundle, file: '/tmp/other.json' }],
				{}
			).data
		).toStrictEqual({
			subjectCount: 1,
			bundles: ['/tmp/bundle.json', '/tmp/other.json'].map((file) => ({
				file,
				subjects: ['app'],
				instance: 'public-good',
				rekorIndices: [],
				timestampCount: 1
			}))
		});
	});
});
