import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface R2Credentials {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
}

/**
 * Minimal view of an R2 bucket: just enough to persist a verified upload.
 */
export interface BlobSink {
	put(
		key: string,
		value: Uint8Array,
		options: { readonly sha256: Uint8Array }
	): Promise<unknown>;
}

/**
 * A `fetch` replacement for tests that stands in for Cloudflare's S3 endpoint.
 * A PUT to an `*.r2.cloudflarestorage.com` URL has its SigV4 presigned
 * signature and `x-amz-checksum-sha256` verified independently of the AWS SDK
 * that produced it; on success the body is written into `sink`. Every other
 * request is delegated to the real `fetch`, so cupboard's own API calls are
 * untouched.
 */
export function presigningFetcher(
	sink: BlobSink,
	credentials: R2Credentials
): typeof fetch {
	return async (input, init) => {
		const url = requestUrl(input);

		if (!url.hostname.endsWith('r2.cloudflarestorage.com')) {
			return fetch(input, init);
		}

		const headers = new Headers(init?.headers);
		const body = await readBody(init?.body);

		return handlePresignedPut(url, headers, body, sink, credentials);
	};
}

async function handlePresignedPut(
	url: URL,
	headers: Headers,
	body: Uint8Array,
	sink: BlobSink,
	credentials: R2Credentials
): Promise<Response> {
	const expected = url.searchParams.get('X-Amz-Signature');
	const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders');
	const amzDate = url.searchParams.get('X-Amz-Date');
	const credential = url.searchParams.get('X-Amz-Credential');

	if (
		expected === null ||
		signedHeaders === null ||
		amzDate === null ||
		credential === null
	) {
		return textResponse(403, 'Missing SigV4 query parameters');
	}

	const scope = credential.slice(credential.indexOf('/') + 1);
	const signedHeaderNames = signedHeaders.split(';');

	// R2 enforces the SigV4 rule that every x-amz-* header on the request must
	// be signed: sending one outside the signed set fails the whole signature.
	for (const name of headers.keys()) {
		if (name.startsWith('x-amz-') && !signedHeaderNames.includes(name)) {
			return textResponse(403, `SignatureDoesNotMatch: unsigned ${name}`);
		}
	}

	const actual = signRequest({
		url,
		headers,
		signedHeaderNames,
		amzDate,
		scope,
		secretAccessKey: credentials.secretAccessKey
	});

	if (!isSignatureMatch(expected, actual)) {
		return textResponse(403, 'SigV4 signature mismatch');
	}

	// R2 only honours the checksum as a signed header; a query-hoisted value
	// is ignored, which silently drops integrity enforcement. The harness is
	// stricter than R2 here and requires it, since enforced integrity is part
	// of the upload contract under test.
	if (!signedHeaderNames.includes('x-amz-checksum-sha256')) {
		return textResponse(400, 'x-amz-checksum-sha256 must be a signed header');
	}

	const checksum = headers.get('x-amz-checksum-sha256');
	const actualChecksum = createHash('sha256').update(body).digest('base64');

	if (checksum !== actualChecksum) {
		return textResponse(400, 'Checksum mismatch');
	}

	await sink.put(decodeURIComponent(objectKey(url)), body, {
		sha256: Buffer.from(actualChecksum, 'base64')
	});

	return new Response(undefined, { status: 200 });
}

interface SignParameters {
	readonly url: URL;
	readonly headers: Headers;
	readonly signedHeaderNames: readonly string[];
	readonly amzDate: string;
	readonly scope: string;
	readonly secretAccessKey: string;
}

function signRequest(parameters: SignParameters): string {
	const canonicalRequest = [
		'PUT',
		parameters.url.pathname,
		canonicalQuery(parameters.url),
		`${canonicalHeaders(parameters)}\n`,
		parameters.signedHeaderNames.join(';'),
		'UNSIGNED-PAYLOAD'
	].join('\n');

	const stringToSign = [
		'AWS4-HMAC-SHA256',
		parameters.amzDate,
		parameters.scope,
		createHash('sha256').update(canonicalRequest).digest('hex')
	].join('\n');

	return hmac(signingKey(parameters), stringToSign).toString('hex');
}

function signingKey(parameters: SignParameters): Buffer {
	const [date, region, service] = parameters.scope.split('/');
	const dateKey = hmac(`AWS4${parameters.secretAccessKey}`, date ?? '');
	const regionKey = hmac(dateKey, region ?? '');
	const serviceKey = hmac(regionKey, service ?? '');

	return hmac(serviceKey, 'aws4_request');
}

function canonicalQuery(url: URL): string {
	const parameters: [string, string][] = [];

	for (const [name, value] of url.searchParams) {
		if (name === 'X-Amz-Signature') {
			continue;
		}

		parameters.push([awsUriEncode(name), awsUriEncode(value)]);
	}

	return parameters
		.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([name, value]) => `${name}=${value}`)
		.join('&');
}

function canonicalHeaders(parameters: SignParameters): string {
	return parameters.signedHeaderNames
		.map((name) => `${name}:${headerValue(parameters, name)}`)
		.join('\n');
}

function headerValue(parameters: SignParameters, name: string): string {
	if (name === 'host') {
		return parameters.url.host;
	}

	return (parameters.headers.get(name) ?? '').trim();
}

function objectKey(url: URL): string {
	const withoutBucket = url.pathname.replace(/^\/[^/]+\//, '');

	return withoutBucket;
}

function awsUriEncode(value: string): string {
	return [...Buffer.from(value, 'utf8')]
		.map((byte) => {
			const character = String.fromCodePoint(byte);

			if (/[A-Za-z0-9\-_.~]/.test(character)) {
				return character;
			}

			return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
		})
		.join('');
}

function isSignatureMatch(expected: string, actual: string): boolean {
	const expectedBytes = Buffer.from(expected, 'utf8');
	const actualBytes = Buffer.from(actual, 'utf8');

	if (expectedBytes.byteLength !== actualBytes.byteLength) {
		return false;
	}

	return timingSafeEqual(expectedBytes, actualBytes);
}

function hmac(key: Buffer | string, value: string): Buffer {
	return createHmac('sha256', key).update(value).digest();
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
	if (input instanceof URL) {
		return input;
	}

	if (input instanceof Request) {
		return new URL(input.url);
	}

	return new URL(input);
}

async function readBody(body: RequestInit['body']): Promise<Uint8Array> {
	if (body === null || body === undefined) {
		return new Uint8Array();
	}

	const response = new Response(body);
	return new Uint8Array(await response.arrayBuffer());
}

function textResponse(status: number, message: string): Response {
	return new Response(`${message}\n`, { status });
}
