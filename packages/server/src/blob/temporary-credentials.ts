import type { TtlSeconds } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import type { R2Credential } from '@cupboard/protocol/upload';

import type { R2PresignerConfiguration } from './presign.ts';

export type R2CredentialScope =
	| 'object-read-only'
	| 'object-read-write'
	| 'admin-read-only'
	| 'admin-read-write';

// R2 accepts either a preset scope or an explicit S3-operation allow-list. A
// credential that includes both `scope` and `actions` is rejected.
export type R2CredentialGrant =
	| { readonly scope: R2CredentialScope }
	| { readonly actions: readonly string[] };

export type R2TemporaryCredentialOptions = R2CredentialGrant & {
	readonly prefixPaths?: readonly string[];
	readonly objectPaths?: readonly string[];
	readonly ttlSeconds: TtlSeconds;
};

// Include PutObject and the multipart lifecycle, but no read or list operation.
// The resulting credential can stage bytes without reading another upload.
export const pushUploadActions = [
	'PutObject',
	'CreateMultipartUpload',
	'UploadPart',
	'CompleteMultipartUpload',
	'AbortMultipartUpload'
] as const;

const textEncoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
	let binary = '';

	for (const byte of bytes) {
		binary += String.fromCodePoint(byte);
	}

	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}

function base64UrlJson(value: unknown): string {
	return base64Url(textEncoder.encode(JSON.stringify(value)));
}

async function hmacSha256(key: string, data: string): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		textEncoder.encode(key),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);

	const signature = await crypto.subtle.sign(
		'HMAC',
		cryptoKey,
		textEncoder.encode(data)
	);

	return new Uint8Array(signature);
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

/**
 * Creates an R2 temporary credential locally. The parent secret signs an HS256
 * JWT, the parent access key ID is reused, and the temporary secret is the
 * SHA-256 digest of the JWT. R2 enforces the JWT's bucket, grant and path claims.
 * This operation makes no network request.
 */
export async function createR2TemporaryCredentials(
	configuration: R2PresignerConfiguration,
	options: R2TemporaryCredentialOptions,
	now: Date
): Promise<R2Credential> {
	const endpoint = `https://${configuration.accountId}.r2.cloudflarestorage.com`;
	const issuedAt = Math.floor(now.getTime() / 1000);
	const expiresAt = issuedAt + options.ttlSeconds;

	const claims: Record<string, unknown> = {
		bucket: configuration.bucketName,
		...('scope' in options
			? { scope: options.scope }
			: { actions: options.actions }),
		paths: {
			prefixPaths: options.prefixPaths ?? [],
			objectPaths: options.objectPaths ?? []
		},
		sub: configuration.accountId,
		iss: configuration.accessKeyId,
		aud: new URL(endpoint).host,
		iat: issuedAt,
		exp: expiresAt
	};

	const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
	const payload = base64UrlJson(claims);
	const signature = base64Url(
		await hmacSha256(configuration.secretAccessKey, `${header}.${payload}`)
	);
	const jwt = `${header}.${payload}.${signature}`;

	return {
		accessKeyId: configuration.accessKeyId,
		secretAccessKey: await sha256Hex(jwt),
		sessionToken: btoa(`jwt/${jwt}`),
		endpoint,
		bucket: configuration.bucketName,
		expiresAt: isoTimestamp(new Date(expiresAt * 1000))
	};
}
