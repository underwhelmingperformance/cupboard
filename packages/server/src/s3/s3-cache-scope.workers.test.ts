import {
	cacheNameSchema,
	cachePrioritySchema,
	DEFAULT_CACHE,
	narInfoGenerationSchema,
	type StoredCache,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import type { ParsedUploadPathMetadata } from '@cupboard/protocol/upload';
import { AwsClient } from 'aws4fetch';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoObjectKey, narObjectKey } from '../http/http.ts';
import {
	bootstrap,
	currentServer,
	fileHash,
	narBytes,
	narHash,
	resetTestServer,
	syntheticNarHash,
	syntheticStorePathHash,
	uploadMetadata,
	useTestServer
} from '../test-support.ts';

import {
	createEncryptionKeyset,
	encryptSecret,
	importEncryptionKey
} from './credentials.ts';

const bucket = tenantIdSchema.parse('v1');
const builds = cacheNameSchema.parse('builds');
const defaultCache: StoredCache = DEFAULT_CACHE;
const accessKeyId = 'AKIDSCOPETEST';
const secretAccessKey = 'scope-test-secret-access-key';
const createdAt = isoTimestamp(new Date('2026-01-01T00:00:00.000Z'));
const generation = narInfoGenerationSchema.parse(0);
const priority = cachePrioritySchema.parse(40);

async function seedCredential(cache: string): Promise<void> {
	const keyset = createEncryptionKeyset(
		await importEncryptionKey(env.S3_SECRET_KEY)
	);
	const secretCiphertext = await encryptSecret(keyset, secretAccessKey);

	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.insert(schema.s3Credentials)
			.values({
				accessKeyId,
				credentialId: 'scope-credential',
				secretCiphertext,
				cache,
				grantsJson: '[]',
				label: 'scope test',
				createdAt,
				expiresAt: undefined
			})
			.run();
	});
}

async function signedGet(path: string): Promise<Response> {
	const signer = new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: 's3',
		region: 'auto'
	});
	const url = `https://s3.example.com/${bucket}/${path}`;
	const signed = await signer.sign(url, {
		method: 'GET',
		aws: { service: 's3', region: 'auto' }
	});
	const headers = new Headers(signed.headers);
	headers.set('x-cupboard-s3', '1');

	return currentServer().fetch(new Request(url, { headers }));
}

async function seedCommittedDefaultPath(
	metadata: ParsedUploadPathMetadata
): Promise<void> {
	await runInDurableObject(currentServer(), async (instance) => {
		instance.context.db
			.insert(schema.narInfos)
			.values({
				cache: '',
				storePathHash: metadata.storePathHash,
				storePath: metadata.storePath,
				narHash: metadata.narHash,
				narSize: metadata.narSize,
				referencesJson: JSON.stringify(metadata.references),
				generation,
				createdAt
			})
			.run();
		await instance.context.d1.insert(d1Schema.blobState).values({
			narHash: metadata.narHash,
			fileHash: metadata.fileHash,
			fileSize: metadata.fileSize,
			compression: metadata.compression,
			narSize: metadata.narSize,
			verifiedAt: createdAt
		});
		await instance.context.d1.insert(d1Schema.blobReference).values({
			tenant: bucket,
			cache: '',
			storePathHash: metadata.storePathHash,
			generation,
			narHash: metadata.narHash
		});
		await instance.context.d1.insert(d1Schema.tenantBlob).values({
			tenant: bucket,
			narHash: metadata.narHash,
			fileSize: metadata.fileSize
		});
	});
	await env.BLOBS.put(narObjectKey(metadata.narHash), narBytes);
}

async function seedListingPaths(count: number): Promise<void> {
	const database = drizzleD1(env.CUPBOARD_DB, {
		schema: { blobReference: d1Schema.blobReference }
	});
	const rows = Array.from({ length: count }, (_unused, index) => ({
		tenant: bucket,
		cache: defaultCache,
		storePathHash: syntheticStorePathHash(index),
		generation,
		narHash: syntheticNarHash(index)
	}));

	for (let offset = 0; offset < rows.length; offset += 15) {
		await database
			.insert(d1Schema.blobReference)
			.values(rows.slice(offset, offset + 15));
	}

	await Promise.all(
		rows
			.slice(0, 5)
			.map((row) =>
				env.BLOBS.put(
					narInfoObjectKey(bucket, row.storePathHash, ''),
					new Uint8Array([1])
				)
			)
	);
}

function listedKeys(xml: string): string[] {
	return xml
		.matchAll(/<Key>([^<]+)<\/Key>/g)
		.map((match) => match[1] ?? '')
		.toArray();
}

function commonPrefixes(xml: string): string[] {
	return xml
		.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g)
		.map((match) => match[1] ?? '')
		.toArray();
}

function continuationToken(xml: string): string | undefined {
	return /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(
		xml
	)?.[1];
}

describe('S3 cache scope', () => {
	beforeEach(resetTestServer);

	it('does not serve a NAR through a cache that has no committed reference', async () => {
		await useTestServer('s3-nar-cache-scope');
		await bootstrap();
		await seedCommittedDefaultPath(
			uploadMetadata({ fileSize: narBytes.byteLength })
		);
		await seedCredential(builds);

		const responses = await Promise.all([
			signedGet(`builds/nar/${narHash}.nar.zst`),
			signedGet(`builds/nar/${fileHash.toString()}.nar.zst`)
		]);

		expect(responses.map((response) => response.status)).toStrictEqual([
			StatusCodes.NOT_FOUND,
			StatusCodes.NOT_FOUND
		]);
	});

	it('does not list a narinfo reservation before its reference edge commits', async () => {
		await useTestServer('s3-list-committed-edges');
		await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await seedCommittedDefaultPath(metadata);
		await seedCredential(builds);

		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db
				.insert(schema.caches)
				.values({
					name: builds,
					priority,
					createdAt
				})
				.run();
			instance.context.db
				.insert(schema.narInfos)
				.values({
					cache: builds,
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath,
					narHash: metadata.narHash,
					narSize: metadata.narSize,
					referencesJson: JSON.stringify(metadata.references),
					generation,
					createdAt
				})
				.run();
		});
		await env.BLOBS.put(
			narInfoObjectKey(bucket, metadata.storePathHash, builds),
			new Uint8Array([1])
		);

		const response = await signedGet('?list-type=2&prefix=builds%2F');

		expect(response.status).toBe(StatusCodes.OK);
		expect(listedKeys(await response.text())).toStrictEqual([
			'builds/nix-cache-info'
		]);
	});

	it('groups committed NAR keys under the requested delimiter', async () => {
		await useTestServer('s3-list-delimiter');
		await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await seedCommittedDefaultPath(metadata);
		await seedCredential('');
		await env.BLOBS.put(
			narInfoObjectKey(bucket, metadata.storePathHash, ''),
			new Uint8Array([1])
		);

		const response = await signedGet('?list-type=2&delimiter=%2F');
		const body = await response.text();

		expect(response.status).toBe(StatusCodes.OK);
		expect(listedKeys(body)).toStrictEqual([
			`${metadata.storePathHash}.narinfo`,
			'nix-cache-info'
		]);
		expect(body).toContain('<Prefix>nar/</Prefix>');
	});

	it('advances past a common prefix continuation token', async () => {
		await useTestServer('s3-list-common-prefix-continuation');
		await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await seedCommittedDefaultPath(metadata);
		await seedCredential('');

		const first = await signedGet(
			'?list-type=2&prefix=n&delimiter=%2F&max-keys=1'
		);
		const firstBody = await first.text();
		const second = await signedGet(
			'?list-type=2&prefix=n&delimiter=%2F&max-keys=1&continuation-token=nar%2F'
		);
		const secondBody = await second.text();

		expect({
			first: {
				status: first.status,
				keys: listedKeys(firstBody),
				prefixes: commonPrefixes(firstBody),
				token: continuationToken(firstBody)
			},
			second: {
				status: second.status,
				keys: listedKeys(secondBody),
				prefixes: commonPrefixes(secondBody),
				token: continuationToken(secondBody)
			}
		}).toStrictEqual({
			first: {
				status: StatusCodes.OK,
				keys: [],
				prefixes: ['nar/'],
				token: 'nar/'
			},
			second: {
				status: StatusCodes.OK,
				keys: ['nix-cache-info'],
				prefixes: [],
				token: undefined
			}
		});
	});

	it('returns a common prefix only once when cache metadata shares it', async () => {
		await useTestServer('s3-list-shared-common-prefix');
		await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await seedCommittedDefaultPath(metadata);
		await seedCredential('');

		const response = await signedGet('?list-type=2&delimiter=n');
		const body = await response.text();

		expect({
			status: response.status,
			sharedPrefixes: commonPrefixes(body).filter((prefix) => prefix === 'n')
		}).toStrictEqual({
			status: StatusCodes.OK,
			sharedPrefixes: ['n']
		});
	});

	it('returns an empty successful page for max-keys zero', async () => {
		await useTestServer('s3-list-empty-page');
		await bootstrap();
		await seedCredential('');

		const response = await signedGet('?list-type=2&max-keys=0');
		const body = await response.text();

		expect(response.status).toBe(StatusCodes.OK);
		expect(listedKeys(body)).toStrictEqual([]);
		expect(body).toContain('<MaxKeys>0</MaxKeys>');
		expect(body).toContain('<IsTruncated>false</IsTruncated>');
	});

	it('reads a bounded index page from a large cache', async () => {
		await useTestServer('s3-list-bounded-page');
		await bootstrap();
		await seedCredential('');
		await seedListingPaths(250);

		const response = await signedGet('?list-type=2&max-keys=5');
		const body = await response.text();
		const measuredNarinfos = await env.CUPBOARD_DB.prepare(
			`select distinct store_path_hash
			 from blob_ref
			 where tenant = ? and cache = ? and store_path_hash >= ?
			 order by store_path_hash
			 limit ?`
		)
			.bind(bucket, '', '', 7)
			.all();
		const measuredNars = await env.CUPBOARD_DB.prepare(
			`select distinct nar_hash
			 from blob_ref
			 where tenant = ? and cache = ? and nar_hash >= ?
			 order by nar_hash
			 limit ?`
		)
			.bind(bucket, '', '', 7)
			.all();

		expect({
			status: response.status,
			keys: listedKeys(body),
			isTruncated: body.includes('<IsTruncated>true</IsTruncated>'),
			rowsRead: {
				narinfos: measuredNarinfos.meta.rows_read,
				nars: measuredNars.meta.rows_read
			}
		}).toStrictEqual({
			status: StatusCodes.OK,
			keys: Array.from(
				{ length: 5 },
				(_unused, index) => `${syntheticStorePathHash(index)}.narinfo`
			),
			isTruncated: true,
			rowsRead: { narinfos: 8, nars: 8 }
		});
	});

	it('bounds listing work for a delimiter inside every NAR key', async () => {
		await useTestServer('s3-list-bounded-arbitrary-delimiter');
		await bootstrap();
		await seedCredential('');
		await seedListingPaths(250);

		const response = await signedGet(
			'?list-type=2&prefix=nar%2F&delimiter=%3A&max-keys=1'
		);
		const body = await response.text();
		const firstCandidate = await env.CUPBOARD_DB.prepare(
			`select distinct nar_hash
			 from blob_ref
			 where tenant = ? and cache = ? and nar_hash >= ?
			 order by nar_hash
			 limit ?`
		)
			.bind(bucket, '', '', 2)
			.all();
		const afterPrefix = await env.CUPBOARD_DB.prepare(
			`select distinct nar_hash
			 from blob_ref
			 where tenant = ? and cache = ? and nar_hash >= ?
			 order by nar_hash
			 limit ?`
		)
			.bind(bucket, '', 'sha256;', 2)
			.all();

		expect({
			status: response.status,
			keys: listedKeys(body),
			prefixes: commonPrefixes(body),
			isTruncated: body.includes('<IsTruncated>true</IsTruncated>'),
			rowsRead: {
				firstCandidate: firstCandidate.meta.rows_read,
				afterPrefix: afterPrefix.meta.rows_read
			}
		}).toStrictEqual({
			status: StatusCodes.OK,
			keys: [],
			prefixes: ['nar/sha256:'],
			isTruncated: false,
			rowsRead: { firstCandidate: 3, afterPrefix: 1 }
		});
	});
});
