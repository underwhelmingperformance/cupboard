import { describe, expect, it } from 'vitest';

import { payloadToArtifact } from './artifact.ts';
import { EmbeddedArtifactError, parseEmbeddedPayload } from './embedded.ts';

const controlSource = `{
	"name": "cupboard",
	"compatibility_date": "2026-05-15",
	"compatibility_flags": ["nodejs_compat"],
	"r2_buckets": [{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" }],
	"d1_databases": [{ "binding": "CUPBOARD_DB", "database_name": "cupboard" }],
	"observability": { "enabled": true }
}`;

const tenantSource = `{
	"name": "cupboard-tenant",
	"compatibility_date": "2026-05-15",
	"compatibility_flags": ["nodejs_compat"],
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["CupboardServer"] }]
}`;

const payloadJson = JSON.stringify({
	controlSource,
	tenantSource,
	controlBundle: { mainModule: 'worker.js', code: 'control-bytes' },
	tenantBundle: { mainModule: 'tenant-worker.js', code: 'tenant-bytes' },
	d1Migrations: [{ name: '0000_a.sql', statements: ['CREATE TABLE a (id);'] }],
	buildVersion: 'abc123def456'
});

describe('parseEmbeddedPayload', () => {
	it('rebuilds the artifact, parsing the embedded wrangler sources', () => {
		const artifact = payloadToArtifact(parseEmbeddedPayload(payloadJson));

		expect(artifact.config.control.name).toBe('cupboard');
		expect(artifact.config.tenant.migrations).toStrictEqual([
			{ tag: 'v1', newSqliteClasses: ['CupboardServer'] }
		]);
		expect(artifact.controlBundle).toStrictEqual({
			mainModule: 'worker.js',
			code: 'control-bytes'
		});
		expect(artifact.d1Migrations).toStrictEqual([
			{ name: '0000_a.sql', statements: ['CREATE TABLE a (id);'] }
		]);
		expect(artifact.buildVersion).toBe('abc123def456');
	});

	it('rejects a payload of the wrong shape', () => {
		expect(() => parseEmbeddedPayload('{"controlSource":"x"}')).toThrow(
			EmbeddedArtifactError
		);
	});
});
