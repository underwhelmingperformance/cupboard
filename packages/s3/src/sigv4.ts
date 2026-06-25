import { AwsV4Signer } from 'aws4fetch';

import {
	ClockSkewExceededError,
	InvalidAmzDateError,
	InvalidAmzExpiresError,
	MalformedAuthorizationHeaderError,
	MalformedCredentialScopeError,
	MalformedPresignedUrlError,
	PresignedUrlExpiredError,
	RequestNotSignedError,
	SignatureDoesNotMatchError,
	UnsupportedAuthorizationSchemeError,
	UnsupportedSigningAlgorithmError
} from './errors.ts';
import type { CredentialResolver, S3Principal } from './ports.ts';

interface ParsedAuth {
	readonly accessKeyId: string;
	readonly region: string;
	readonly service: string;
	readonly signedHeaders: readonly string[];
	readonly signature: string;
	readonly amzDate: string;
	readonly signQuery: boolean;
}

export interface VerifyOptions {
	/** Current time, injected for testability; defaults to the real clock. */
	readonly now?: Date;
}

/**
 * Whether a request carries SigV4 credentials at all (header or presigned).
 * Anonymous requests carry neither and are handled without verification.
 */
export function isSigned(request: Request): boolean {
	const url = new URL(request.url);
	return (
		request.headers.has('authorization') ||
		url.searchParams.has('X-Amz-Algorithm')
	);
}

/**
 * Verifies a SigV4-signed request by reconstructing the canonical request from
 * its declared `SignedHeaders` and re-signing it with the credential's secret,
 * then comparing signatures in constant time. The request body is never read,
 * so verification is streaming-safe across all `x-amz-content-sha256` modes.
 *
 * Returns the authenticated principal, or throws an {@link S3Error}.
 */
export async function verifySignature(
	request: Request,
	resolver: CredentialResolver,
	options: VerifyOptions = {}
): Promise<S3Principal> {
	const url = new URL(request.url);
	const parsed = parseAuth(request, url);

	const credential = await resolver.resolve(parsed.accessKeyId);
	if (credential === undefined) {
		throw new SignatureDoesNotMatchError();
	}

	const now = options.now ?? new Date();
	if (parsed.signQuery) {
		assertNotExpired(url, parsed.amzDate, now);
	} else {
		assertWithinClockSkew(parsed.amzDate, now);
	}

	const expected = await reSign(
		request,
		url,
		parsed,
		credential.secretAccessKey
	);

	if (!isConstantTimeEqual(expected, parsed.signature)) {
		throw new SignatureDoesNotMatchError();
	}

	return credential.principal;
}

async function reSign(
	request: Request,
	url: URL,
	parsed: ParsedAuth,
	secretAccessKey: string
): Promise<string> {
	const headers = new Headers();
	for (const name of parsed.signedHeaders) {
		if (name === 'host') {
			continue;
		}

		const value = request.headers.get(name);
		if (value !== null) {
			headers.set(name, value);
		}
	}

	const signerUrl = new URL(url);
	signerUrl.searchParams.delete('X-Amz-Signature');

	const signer = new AwsV4Signer({
		method: request.method,
		url: signerUrl.href,
		headers,
		accessKeyId: parsed.accessKeyId,
		secretAccessKey,
		region: parsed.region,
		service: parsed.service,
		datetime: parsed.amzDate,
		signQuery: parsed.signQuery,
		allHeaders: true
	});

	if (signer.signedHeaders !== parsed.signedHeaders.join(';')) {
		throw new SignatureDoesNotMatchError();
	}

	return signer.signature();
}

function parseAuth(request: Request, url: URL): ParsedAuth {
	const header = request.headers.get('authorization');
	if (header !== null) {
		return parseHeaderAuth(header, request);
	}

	if (url.searchParams.has('X-Amz-Algorithm')) {
		return parseQueryAuth(url);
	}

	throw new RequestNotSignedError();
}

const credentialPattern = /Credential=([^,]+)/;
const signedHeadersPattern = /SignedHeaders=([^,]+)/;
const signaturePattern = /Signature=([0-9a-fA-F]+)/;

function parseHeaderAuth(header: string, request: Request): ParsedAuth {
	if (!header.startsWith('AWS4-HMAC-SHA256')) {
		throw new UnsupportedAuthorizationSchemeError();
	}

	const credential = credentialPattern.exec(header)?.[1];
	const signedHeaders = signedHeadersPattern.exec(header)?.[1];
	const signature = signaturePattern.exec(header)?.[1];
	const amzDate = request.headers.get('x-amz-date');

	if (
		credential === undefined ||
		signedHeaders === undefined ||
		signature === undefined ||
		amzDate === null
	) {
		throw new MalformedAuthorizationHeaderError();
	}

	const scope = parseCredentialScope(credential);

	return {
		accessKeyId: scope.accessKeyId,
		region: scope.region,
		service: scope.service,
		signedHeaders: signedHeaders.split(';'),
		signature,
		amzDate,
		signQuery: false
	};
}

function parseQueryAuth(url: URL): ParsedAuth {
	const algorithm = url.searchParams.get('X-Amz-Algorithm');
	if (algorithm !== 'AWS4-HMAC-SHA256') {
		throw new UnsupportedSigningAlgorithmError();
	}

	const credential = url.searchParams.get('X-Amz-Credential');
	const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders');
	const signature = url.searchParams.get('X-Amz-Signature');
	const amzDate = url.searchParams.get('X-Amz-Date');

	if (
		credential === null ||
		signedHeaders === null ||
		signature === null ||
		amzDate === null
	) {
		throw new MalformedPresignedUrlError();
	}

	const scope = parseCredentialScope(credential);

	return {
		accessKeyId: scope.accessKeyId,
		region: scope.region,
		service: scope.service,
		signedHeaders: signedHeaders.split(';'),
		signature,
		amzDate,
		signQuery: true
	};
}

interface CredentialScope {
	readonly accessKeyId: string;
	readonly region: string;
	readonly service: string;
}

function parseCredentialScope(credential: string): CredentialScope {
	const parts = credential.split('/');
	const [accessKeyId, , region, service, terminator] = parts;

	if (
		parts.length !== 5 ||
		accessKeyId === undefined ||
		accessKeyId === '' ||
		region === undefined ||
		service === undefined ||
		terminator !== 'aws4_request'
	) {
		throw new MalformedCredentialScopeError();
	}

	return { accessKeyId, region, service };
}

// A header-signed request carries no expiry of its own, so it is bounded by a
// clock-skew window instead: without one, a captured Authorization header would
// re-verify and replay indefinitely. AWS uses the same ~15-minute tolerance.
const maxClockSkewMs = 15 * 60 * 1000;

function assertWithinClockSkew(amzDate: string, now: Date): void {
	const signedAt = parseAmzDate(amzDate);
	if (signedAt === undefined) {
		throw new InvalidAmzDateError();
	}

	if (Math.abs(now.getTime() - signedAt) > maxClockSkewMs) {
		throw new ClockSkewExceededError();
	}
}

// AWS caps a presigned URL's validity at one week. A request that omits
// `X-Amz-Expires`, or asks for a non-positive or longer-than-permitted window,
// is rejected as malformed. `X-Amz-Expires` is part of the signed query, so a
// stripped value is also caught here before the signature check.
const maxPresignExpirySeconds = 7 * 24 * 60 * 60;

function assertNotExpired(url: URL, amzDate: string, now: Date): void {
	const raw = url.searchParams.get('X-Amz-Expires');
	if (raw === null || !/^[0-9]+$/.test(raw)) {
		throw new InvalidAmzExpiresError();
	}

	const expires = Number(raw);
	if (expires <= 0 || expires > maxPresignExpirySeconds) {
		throw new InvalidAmzExpiresError();
	}

	const signedAt = parseAmzDate(amzDate);
	if (signedAt === undefined) {
		throw new InvalidAmzDateError();
	}

	if (now.getTime() > signedAt + expires * 1000) {
		throw new PresignedUrlExpiredError();
	}
}

function parseAmzDate(value: string): number | undefined {
	const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
	if (match === null) {
		return undefined;
	}

	const [, year, month, day, hour, minute, second] = match;
	return Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second)
	);
}

function isConstantTimeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) {
		return false;
	}

	let mismatch = 0;
	for (let index = 0; index < left.length; index++) {
		mismatch |=
			(left.codePointAt(index) ?? 0) ^ (right.codePointAt(index) ?? 0);
	}

	return mismatch === 0;
}
