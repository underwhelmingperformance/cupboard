import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { payloadToArtifact } from './artifact.ts';
import { EmbeddedArtifactError, parseEmbeddedPayload } from './embedded.ts';

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

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

		expect(artifact).toStrictEqual({
			config: {
				control: {
					name: 'cupboard',
					mainModule: 'worker.js',
					compatibilityDate: '2026-05-15',
					compatibilityFlags: ['nodejs_compat'],
					cpuMs: undefined,
					observability: true,
					tracing: false,
					vars: {},
					durableObjects: [],
					r2Buckets: [{ binding: 'BLOBS', bucketName: 'cupboard-blobs' }],
					kvNamespaces: [],
					d1Databases: [{ binding: 'CUPBOARD_DB', databaseName: 'cupboard' }],
					queueProducers: [],
					queueConsumers: [],
					services: [],
					cacheEnabled: false,
					workersDev: true,
					previewUrls: true,
					crons: [],
					migrations: []
				},
				tenant: {
					name: 'cupboard-tenant',
					mainModule: 'tenant-worker.js',
					compatibilityDate: '2026-05-15',
					compatibilityFlags: ['nodejs_compat'],
					cpuMs: undefined,
					observability: false,
					tracing: false,
					vars: {},
					durableObjects: [],
					r2Buckets: [],
					kvNamespaces: [],
					d1Databases: [],
					queueProducers: [],
					queueConsumers: [],
					services: [],
					cacheEnabled: false,
					workersDev: true,
					previewUrls: true,
					crons: [],
					migrations: [{ tag: 'v1', newSqliteClasses: ['CupboardServer'] }]
				}
			},
			controlBundle: { mainModule: 'worker.js', code: 'control-bytes' },
			tenantBundle: { mainModule: 'tenant-worker.js', code: 'tenant-bytes' },
			d1Migrations: [
				{ name: '0000_a.sql', statements: ['CREATE TABLE a (id);'] }
			],
			buildVersion: 'abc123def456'
		});
	});

	it('rejects a payload of the wrong shape', () => {
		const error = z
			.instanceof(EmbeddedArtifactError)
			.parse(thrownBy(() => parseEmbeddedPayload('{"controlSource":"x"}')));

		expect({
			name: error.name,
			hasDetail: error.detail.length > 0
		}).toStrictEqual({
			name: 'EmbeddedArtifactError',
			hasDetail: true
		});
	});
});
