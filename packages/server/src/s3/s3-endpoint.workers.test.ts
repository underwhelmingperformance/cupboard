import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	nixSha256HashSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { AwsClient } from 'aws4fetch';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import { narInfoObjectKey } from '../http/http.ts';
import {
	currentServer,
	fileHash,
	narBytes,
	narHash,
	resetTestServer,
	useTestServer
} from '../test-support.ts';

import {
	createEncryptionKeyset,
	encryptSecret,
	importEncryptionKey
} from './credentials.ts';

const bucket = 'v1';
const accessKeyId = 'AKIDTEST';
const secretAccessKey = 'test-secret-access-key-value';

function s3Request(headers: HeadersInit): Request {
	return new Request(`https://s3.example.com/${bucket}/nix-cache-info`, {
		method: 'GET',
		headers
	});
}

async function signedS3(
	method: string,
	path: string,
	body?: Uint8Array | string
): Promise<Response> {
	const signer = new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: 's3',
		region: 'auto'
	});
	const url = `https://s3.example.com/${bucket}/${path}`;
	const signed = await signer.sign(url, {
		method,
		aws: { service: 's3', region: 'auto' }
	});
	const headers = new Headers(signed.headers);
	headers.set('x-cupboard-s3', '1');

	return currentServer().fetch(new Request(url, { method, headers, body }));
}

async function seedCredential(): Promise<void> {
	const keyset = createEncryptionKeyset(
		await importEncryptionKey(env.S3_SECRET_KEY)
	);
	const ciphertext = await encryptSecret(keyset, secretAccessKey);

	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema })
			.insert(schema.s3Credentials)
			.values({
				accessKeyId,
				credentialId: 'cred-1',
				secretCiphertext: ciphertext,
				cache: '',
				grantsJson: JSON.stringify(['upload:commit']),
				label: 'test',
				createdAt: '2026-01-01T00:00:00.000Z',
				expiresAt: undefined
			})
			.run();
	});
}

describe('S3 endpoint mount', () => {
	beforeEach(resetTestServer);

	it('serves nix-cache-info to an anonymous read on a public tenant', async () => {
		await useTestServer('s3-mount-anonymous');
		// Trigger the migration so the default cache exists before reading.
		await currentServer().fetch(new Request('https://do.invalid/pubkey'));

		const response = await currentServer().fetch(
			s3Request({ 'x-cupboard-s3': '1' })
		);
		expect(response.status).toBe(StatusCodes.OK);
		expect(await response.text()).toContain('StoreDir: /nix/store');
	});

	it('serves nix-cache-info to a signed request with a valid credential', async () => {
		await useTestServer('s3-mount-signed');
		// Trigger the migration so the credential table exists before seeding.
		await currentServer().fetch(new Request('https://do.invalid/pubkey'));
		await seedCredential();

		const signer = new AwsClient({
			accessKeyId,
			secretAccessKey,
			service: 's3',
			region: 'auto'
		});
		const signed = await signer.sign(
			`https://s3.example.com/${bucket}/nix-cache-info`,
			{ method: 'GET', aws: { service: 's3', region: 'auto' } }
		);

		const headers = new Headers(signed.headers);
		headers.set('x-cupboard-s3', '1');

		const response = await currentServer().fetch(s3Request(headers));
		expect(response.status).toBe(StatusCodes.OK);
		expect(await response.text()).toContain('StoreDir: /nix/store');
	});

	it('rejects a tampered signature with 403', async () => {
		await useTestServer('s3-mount-tampered');
		await currentServer().fetch(new Request('https://do.invalid/pubkey'));
		await seedCredential();

		const signer = new AwsClient({
			accessKeyId,
			secretAccessKey: 'the-wrong-secret',
			service: 's3',
			region: 'auto'
		});
		const signed = await signer.sign(
			`https://s3.example.com/${bucket}/nix-cache-info`,
			{ method: 'GET', aws: { service: 's3', region: 'auto' } }
		);

		const headers = new Headers(signed.headers);
		headers.set('x-cupboard-s3', '1');

		const response = await currentServer().fetch(s3Request(headers));
		expect(response.status).toBe(StatusCodes.FORBIDDEN);
		expect(await response.text()).toContain('SignatureDoesNotMatch');
	});
});

describe('S3 endpoint write path', () => {
	beforeEach(resetTestServer);

	it('ingests a NAR and narinfo, then serves them back', async () => {
		await useTestServer('s3-write');
		await currentServer().fetch(new Request('https://do.invalid/pubkey'));
		await seedCredential();

		const storePathHash = storePathHashSchema.parse('0'.repeat(32));
		const narBase32 = fileHash.toString().slice('sha256:'.length);
		const narinfo = new NarInfo(
			new StorePath(`/nix/store/${storePathHash}-name`),
			`nar/${narBase32}.nar.zst`,
			'zstd',
			fileHash,
			narBytes.byteLength,
			NixSha256Hash.parse(narHash),
			1234,
			[]
		).render();

		const stagedNar = await signedS3(
			'PUT',
			`nar/${narBase32}.nar.zst`,
			narBytes
		);
		expect(stagedNar.status).toBe(StatusCodes.OK);

		const committedNarinfo = await signedS3(
			'PUT',
			`${storePathHash}.narinfo`,
			narinfo
		);
		expect(committedNarinfo.status).toBe(StatusCodes.OK);

		const origin = await runInDurableObject(
			currentServer(),
			(_instance, state) =>
				drizzle(state.storage, { schema })
					.select({ origin: schema.narInfos.origin })
					.from(schema.narInfos)
					.get()
		);
		expect(origin?.origin).toBe(
			JSON.stringify({ credentialId: 'cred-1', label: 'test' })
		);

		const narinfoResponse = await signedS3('GET', `${storePathHash}.narinfo`);
		expect(narinfoResponse.status).toBe(StatusCodes.OK);
		const served = await narinfoResponse.text();
		expect(served).toContain(`StorePath: /nix/store/${storePathHash}-name`);
		expect(served).toContain('Sig: ');

		const narResponse = await signedS3('GET', `nar/${narHash}.nar.zst`);
		expect(narResponse.status).toBe(StatusCodes.OK);
		expect(new Uint8Array(await narResponse.arrayBuffer())).toStrictEqual(
			narBytes
		);
	});

	it('rejects NAR bytes that do not match the file-hash key', async () => {
		await useTestServer('s3-write-mismatch');
		await currentServer().fetch(new Request('https://do.invalid/pubkey'));
		await seedCredential();

		const narBase32 = fileHash.toString().slice('sha256:'.length);
		const wrongBytes = new TextEncoder().encode('not the staged nar bytes');

		const response = await signedS3(
			'PUT',
			`nar/${narBase32}.nar.zst`,
			wrongBytes
		);
		expect(response.status).toBe(StatusCodes.BAD_REQUEST);
		expect(await response.text()).toContain('<Code>BadDigest</Code>');
	});
});

const hash0 = storePathHashSchema.parse(`0${'0'.repeat(31)}`);
const hash1 = storePathHashSchema.parse(`1${'0'.repeat(31)}`);
const hash2 = storePathHashSchema.parse(`2${'0'.repeat(31)}`);
const listHashes = [hash0, hash1, hash2];

// A NAR hash with no stored blob, so the listing's `nar/<hash>` key is skipped
// and these tests stay deterministic regardless of what the shared R2 holds.
const listNarHash = nixSha256HashSchema.parse(`sha256:${'0'.repeat(52)}`);

async function seedNarInfo(hash: (typeof listHashes)[number]): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema })
			.insert(schema.narInfos)
			.values({
				cache: '',
				storePathHash: hash,
				storePath: storePathSchema.parse(`/nix/store/${hash}-name`),
				narHash: listNarHash,
				narSize: 1234,
				referencesJson: JSON.stringify([]),
				generation: 0,
				createdAt: '2026-01-01T00:00:00.000Z'
			})
			.run();
	});
	await env.BLOBS.put(narInfoObjectKey(bucket, hash, ''), new Uint8Array([1]));
}

function listedKeys(xml: string): string[] {
	return xml
		.matchAll(/<Key>([^<]+)<\/Key>/g)
		.map((match) => match[1] ?? '')
		.toArray();
}

describe('S3 endpoint listing', () => {
	beforeEach(resetTestServer);

	it('paginates a v2 listing and resumes from the continuation token', async () => {
		await useTestServer('s3-list-v2');
		await currentServer().fetch(new Request('https://do.invalid/pubkey'));
		await seedCredential();
		for (const hash of listHashes) {
			await seedNarInfo(hash);
		}

		// The continuation token is the full last key seen, and the listing also
		// surfaces `nix-cache-info` alongside the narinfo keys.
		const first = await signedS3('GET', '?list-type=2&max-keys=2');
		expect(first.status).toBe(StatusCodes.OK);
		const firstBody = await first.text();
		expect(listedKeys(firstBody)).toStrictEqual([
			`${hash0}.narinfo`,
			`${hash1}.narinfo`
		]);
		expect(firstBody).toContain('<IsTruncated>true</IsTruncated>');
		expect(firstBody).toContain(
			`<NextContinuationToken>${hash1}.narinfo</NextContinuationToken>`
		);

		const second = await signedS3(
			'GET',
			`?list-type=2&continuation-token=${hash1}.narinfo`
		);
		const secondBody = await second.text();
		expect(listedKeys(secondBody)).toStrictEqual([
			`${hash2}.narinfo`,
			'nix-cache-info'
		]);
		expect(secondBody).toContain('<IsTruncated>false</IsTruncated>');
	});

	it('advances a v1 listing from a key-suffixed marker', async () => {
		await useTestServer('s3-list-v1');
		await currentServer().fetch(new Request('https://do.invalid/pubkey'));
		await seedCredential();
		for (const hash of listHashes) {
			await seedNarInfo(hash);
		}

		// A conformant v1 client without a delimiter paginates on the last key it
		// saw, `<hash>.narinfo`. The listing also includes the rendered
		// `nix-cache-info` object.
		const response = await signedS3('GET', `?marker=${hash0}.narinfo`);
		expect(listedKeys(await response.text())).toStrictEqual([
			`${hash1}.narinfo`,
			`${hash2}.narinfo`,
			'nix-cache-info'
		]);
	});
});
