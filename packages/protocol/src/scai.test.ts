import { describe, expect, it } from 'vitest';

import { scaiAttributeReportSchema } from './scai.ts';

describe('scaiAttributeReportSchema', () => {
	const reproduction = {
		attribute: 'REPRODUCIBLE',
		target: {
			name: '0123456789abcdfghijklmnpqrsvwxyz-app',
			digest: { sha256: '11'.repeat(32) }
		},
		conditions: {
			derivation: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app.drv'
		}
	};
	const collection = {
		attribute: 'attestation-1',
		target: {
			name: '0123456789abcdfghijklmnpqrsvwxyz-app',
			digest: { sha256: '11'.repeat(32) }
		},
		evidence: {
			digest: { sha256: '22'.repeat(32) },
			downloadLocation:
				'https://cache.example.test/t/acme/cache/builds/attestation-bundles/' +
				'22'.repeat(32),
			mediaType: 'application/vnd.dev.sigstore.bundle+json',
			annotations: { predicateType: 'https://slsa.dev/provenance/v1' }
		}
	};

	it('accepts reproduction and evidence-collection assertions', () => {
		expect(
			scaiAttributeReportSchema.parse({
				attributes: [reproduction, collection]
			})
		).toStrictEqual({ attributes: [reproduction, collection] });
	});

	it('rejects a report with no assertions', () => {
		expect(() => scaiAttributeReportSchema.parse({ attributes: [] })).toThrow();
	});

	it('accepts optional fields and preserves extensions', () => {
		const report = {
			attributes: [
				{ attribute: 'REPRODUCIBLE', exampleExtension: true },
				{
					attribute: 'ATTESTED_DEPENDENCIES',
					target: { uri: 'https://example.test/dependency', version: '1' },
					evidence: { content: 'aGVsbG8=', mediaType: 'text/plain' }
				}
			],
			producer: { uri: 'https://example.test/builder' },
			exampleExtension: { enabled: true }
		};

		expect(scaiAttributeReportSchema.parse(report)).toStrictEqual(report);
	});

	it.each(['not-a-digest', 'AA'.repeat(32), '11'.repeat(31)])(
		'rejects malformed SHA-256 %s',
		(sha256) => {
			expect(() =>
				scaiAttributeReportSchema.parse({
					attributes: [
						{
							...reproduction,
							target: { ...reproduction.target, digest: { sha256 } }
						}
					]
				})
			).toThrow();
		}
	);

	it('rejects an evidence entry without uri, digest or content', () => {
		expect(() =>
			scaiAttributeReportSchema.parse({
				attributes: [
					{
						attribute: 'attestation-1',
						target: collection.target,
						evidence: { downloadLocation: 'https://example.test/bundle' }
					}
				]
			})
		).toThrow();
	});

	it.each([
		{ target: { uri: 'HTTPS://example.test/dependency' } },
		{ producer: { uri: 'https://Example.test/producer' } },
		{ evidence: { content: 'not base64' } },
		{ target: { digest: {} } }
	])('rejects malformed resource descriptors: %j', (fields) => {
		const { producer, ...assertionFields } = fields;
		expect(() =>
			scaiAttributeReportSchema.parse({
				attributes: [{ attribute: 'CHECKED', ...assertionFields }],
				...(producer !== undefined && { producer })
			})
		).toThrow();
	});
});
