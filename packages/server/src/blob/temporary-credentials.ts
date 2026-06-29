import type { R2PresignerConfiguration } from './presign.ts';

export type R2CredentialScope =
	| 'object-read-only'
	| 'object-read-write'
	| 'admin-read-only'
	| 'admin-read-write';

export interface R2TemporaryCredentialOptions {
	readonly scope: R2CredentialScope;
	readonly prefixPaths?: readonly string[];
	readonly objectPaths?: readonly string[];
	readonly ttlSeconds: number;
}

export interface R2TemporaryCredentials {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken: string;
	readonly endpoint: string;
	readonly bucket: string;
	readonly expiresAt: Date;
}

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
 * Issues a short-lived R2 credential by signing a scope JWT with the parent
 * secret access key, the offline form of R2's Temporary Credentials API. R2
 * recognises the reused parent access key id, validates the JWT signature with
 * the parent secret, and enforces the bucket, scope and path claims; the
 * temporary secret access key the holder signs requests with is the SHA-256 of
 * the JWT. No call leaves the Worker and no credential beyond the R2 secret the
 * presigner already holds is needed.
 */
export async function createR2TemporaryCredentials(
	configuration: R2PresignerConfiguration,
	options: R2TemporaryCredentialOptions,
	now: Date
): Promise<R2TemporaryCredentials> {
	const endpoint = `https://${configuration.accountId}.r2.cloudflarestorage.com`;
	const issuedAt = Math.floor(now.getTime() / 1000);
	const expiresAt = issuedAt + options.ttlSeconds;

	const claims = {
		bucket: configuration.bucketName,
		scope: options.scope,
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
		expiresAt: new Date(expiresAt * 1000)
	};
}
