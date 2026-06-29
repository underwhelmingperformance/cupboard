import { describe, expect, it } from 'vitest';

import type { R2PresignerConfiguration } from './presign.ts';
import {
	createR2TemporaryCredentials,
	pushUploadActions
} from './temporary-credentials.ts';

const configuration: R2PresignerConfiguration = {
	accountId: 'acct-123',
	accessKeyId: 'parent-access-key',
	secretAccessKey: 'parent-secret',
	bucketName: 'cupboard-blobs'
};

const now = new Date('2026-06-29T12:00:00.000Z');
const ttlSeconds = 900;
const issuedAt = Math.floor(now.getTime() / 1000);

const textEncoder = new TextEncoder();

function base64UrlToBytes(value: string): Uint8Array {
	const padded = value
		.replaceAll('-', '+')
		.replaceAll('_', '/')
		.padEnd(Math.ceil(value.length / 4) * 4, '=');
	const binary = atob(padded);

	return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
}

function base64UrlToJson(value: string): unknown {
	return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		textEncoder.encode(value)
	);

	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
}

function jwtFrom(sessionToken: string): {
	readonly jwt: string;
	readonly header: unknown;
	readonly payload: unknown;
	readonly signingInput: string;
	readonly signature: Uint8Array;
} {
	const decoded = atob(sessionToken);

	expect(decoded.startsWith('jwt/')).toBe(true);

	const jwt = decoded.slice('jwt/'.length);
	const [header = '', payload = '', signature = ''] = jwt.split('.');

	return {
		jwt,
		header: base64UrlToJson(header),
		payload: base64UrlToJson(payload),
		signingInput: `${header}.${payload}`,
		signature: base64UrlToBytes(signature)
	};
}

describe('createR2TemporaryCredentials', () => {
	const prefixPaths = ['staging/push-1/'];

	it('reuses the parent key id and reports the endpoint, bucket and expiry', async () => {
		const credentials = await createR2TemporaryCredentials(
			configuration,
			{ scope: 'object-read-write', prefixPaths, ttlSeconds },
			now
		);

		expect({
			accessKeyId: credentials.accessKeyId,
			endpoint: credentials.endpoint,
			bucket: credentials.bucket,
			expiresAt: credentials.expiresAt,
			secretAccessKey: credentials.secretAccessKey
		}).toStrictEqual({
			accessKeyId: 'parent-access-key',
			endpoint: 'https://acct-123.r2.cloudflarestorage.com',
			bucket: 'cupboard-blobs',
			expiresAt: new Date((issuedAt + ttlSeconds) * 1000).toISOString(),
			secretAccessKey: await sha256Hex(jwtFrom(credentials.sessionToken).jwt)
		});
	});

	it('signs an HS256 scope JWT carrying the bucket, scope, prefix and registered claims', async () => {
		const credentials = await createR2TemporaryCredentials(
			configuration,
			{ scope: 'object-read-write', prefixPaths, ttlSeconds },
			now
		);

		const { header, payload } = jwtFrom(credentials.sessionToken);

		expect({ header, payload }).toStrictEqual({
			header: { alg: 'HS256', typ: 'JWT' },
			payload: {
				bucket: 'cupboard-blobs',
				scope: 'object-read-write',
				paths: { prefixPaths, objectPaths: [] },
				sub: 'acct-123',
				iss: 'parent-access-key',
				aud: 'acct-123.r2.cloudflarestorage.com',
				iat: issuedAt,
				exp: issuedAt + ttlSeconds
			}
		});
	});

	it('signs the JWT with the parent secret so R2 can validate it', async () => {
		const credentials = await createR2TemporaryCredentials(
			configuration,
			{ scope: 'object-read-write', prefixPaths, ttlSeconds },
			now
		);

		const { signingInput, signature } = jwtFrom(credentials.sessionToken);

		const key = await crypto.subtle.importKey(
			'raw',
			textEncoder.encode(configuration.secretAccessKey),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['verify']
		);

		const isValidUnderParent = await crypto.subtle.verify(
			'HMAC',
			key,
			signature,
			textEncoder.encode(signingInput)
		);

		const wrongKey = await crypto.subtle.importKey(
			'raw',
			textEncoder.encode('not-the-parent-secret'),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['verify']
		);

		const isValidUnderWrongSecret = await crypto.subtle.verify(
			'HMAC',
			wrongKey,
			signature,
			textEncoder.encode(signingInput)
		);

		expect({ isValidUnderParent, isValidUnderWrongSecret }).toStrictEqual({
			isValidUnderParent: true,
			isValidUnderWrongSecret: false
		});
	});

	it('defaults the object paths to empty and honours an explicit object scope', async () => {
		const credentials = await createR2TemporaryCredentials(
			configuration,
			{
				scope: 'object-read-only',
				prefixPaths,
				objectPaths: ['staging/push-1/one.nar.zst'],
				ttlSeconds
			},
			now
		);

		const { payload } = jwtFrom(credentials.sessionToken);

		expect(payload).toMatchObject({
			scope: 'object-read-only',
			paths: {
				prefixPaths,
				objectPaths: ['staging/push-1/one.nar.zst']
			}
		});
	});

	it('narrows the credential to the upload actions when asked', async () => {
		const credentials = await createR2TemporaryCredentials(
			configuration,
			{
				scope: 'object-read-write',
				actions: pushUploadActions,
				prefixPaths,
				ttlSeconds
			},
			now
		);

		const { payload } = jwtFrom(credentials.sessionToken);

		expect(payload).toMatchObject({
			scope: 'object-read-write',
			actions: [
				'PutObject',
				'CreateMultipartUpload',
				'UploadPart',
				'CompleteMultipartUpload',
				'AbortMultipartUpload'
			],
			paths: { prefixPaths, objectPaths: [] }
		});
	});

	it('grants no read or list operation through the upload action set', () => {
		const readOrList = new Set([
			'GetObject',
			'HeadObject',
			'ListObjectsV2',
			'ListParts',
			'ListMultipartUploads'
		]);

		expect(
			pushUploadActions.filter((action) => readOrList.has(action))
		).toStrictEqual([]);
	});
});
