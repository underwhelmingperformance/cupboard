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
	RequestNotYetValidError,
	SignatureDoesNotMatchError,
	UnsupportedAuthorizationSchemeError,
	UnsupportedPayloadModeError,
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
	/**
	Current time, injected for testability; defaults to the real clock.
	*/
	readonly now?: Date;
}

/**
 * Whether a request contains SigV4 credentials in an `Authorization` header or
 * presigned query parameters. Anonymous requests contain neither and do not
 * require verification.
 */
export function isSigned(request: Request): boolean {
	const url = new URL(request.url);
	return (
		request.headers.has('authorization') ||
		url.searchParams.has('X-Amz-Algorithm')
	);
}

/**
 * Verifies a SigV4-signed request. The function reconstructs the canonical
 * request from `SignedHeaders`, signs it with the credential secret, and
 * compares the signatures without returning at the first mismatch. It does not
 * read the request body, so callers can continue to stream every supported
 * `x-amz-content-sha256` mode.
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
		credential.secretAccessKey,
		credential.sessionToken
	);

	if (!areSignaturesEqual(expected, parsed.signature)) {
		throw new SignatureDoesNotMatchError();
	}
	assertSupportedPayloadMode(request);

	return credential.principal;
}

async function reSign(
	request: Request,
	url: URL,
	parsed: ParsedAuth,
	secretAccessKey: string,
	sessionToken: string | undefined
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
	const contentSha256 = request.headers.get('x-amz-content-sha256');
	if (contentSha256 !== null) {
		headers.set('x-amz-content-sha256', contentSha256);
	}

	assertSessionToken(request, url, parsed.signQuery, sessionToken);

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
		sessionToken,
		allHeaders: true
	});

	const expectedSignedHeaders = parsed.signedHeaders.join(';');
	if (
		signer.signedHeaders !== expectedSignedHeaders &&
		!didRemoveUnlistedPayloadHeader(signer, parsed.signedHeaders, contentSha256)
	) {
		throw new SignatureDoesNotMatchError();
	}

	return signer.signature();
}

// aws4fetch treats the S3 payload-hash header as an ordinary signable header.
// Keep its value for the canonical payload hash when the client omitted only
// that header from SignedHeaders, which AWS permits.
function didRemoveUnlistedPayloadHeader(
	signer: AwsV4Signer,
	signedHeaders: readonly string[],
	contentSha256: string | null
): boolean {
	const payloadHeader = 'x-amz-content-sha256';
	if (contentSha256 === null || signedHeaders.includes(payloadHeader)) {
		return false;
	}

	const withoutPayload = signer.signableHeaders.filter(
		(name) => name !== payloadHeader
	);
	const expected = signedHeaders.join(';');
	if (withoutPayload.join(';') !== expected) {
		return false;
	}

	signer.signableHeaders = withoutPayload;
	signer.signedHeaders = expected;
	signer.canonicalHeaders = signer.canonicalHeaders
		.split('\n')
		.filter((line) => !line.startsWith(`${payloadHeader}:`))
		.join('\n');

	return true;
}

function assertSessionToken(
	request: Request,
	url: URL,
	isQuerySigned: boolean,
	expected: string | undefined
): void {
	if (expected === undefined) {
		return;
	}

	const actual = isQuerySigned
		? url.searchParams.get('X-Amz-Security-Token')
		: request.headers.get('x-amz-security-token');
	if (actual === null || !areStringsEqual(actual, expected)) {
		throw new SignatureDoesNotMatchError();
	}
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
		!accessKeyId ||
		region === undefined ||
		service !== 's3' ||
		terminator !== 'aws4_request' ||
		parts.length !== 5
	) {
		throw new MalformedCredentialScopeError();
	}

	return { accessKeyId, region, service };
}

// A header-signed request has no expiry. Limit it to a clock-skew window so a
// captured `Authorization` header cannot be replayed indefinitely. AWS uses a
// similar tolerance of about 15 minutes.
const maxClockSkewMs = 15 * 60 * 1000;

function assertWithinClockSkew(amzDate: string, now: Date): void {
	const signedAt = parseAmzDate(amzDate);
	if (signedAt === undefined) {
		throw new InvalidAmzDateError();
	}

	if (signedAt > now.getTime()) {
		throw new RequestNotYetValidError();
	}

	if (now.getTime() - signedAt > maxClockSkewMs) {
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
	if (signedAt > now.getTime()) {
		throw new RequestNotYetValidError();
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

	const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
		match;
	const year = Number(yearText);
	const month = Number(monthText) - 1;
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	const date = new Date(0);
	date.setUTCFullYear(year, month, day);
	date.setUTCHours(hour, minute, second, 0);

	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month ||
		date.getUTCDate() !== day ||
		date.getUTCHours() !== hour ||
		date.getUTCMinutes() !== minute ||
		date.getUTCSeconds() !== second
	) {
		return undefined;
	}

	return date.getTime();
}

const fixedPayloadDigestPattern = /^[0-9a-f]{64}$/i;
const supportedPayloadModes = new Set([
	'UNSIGNED-PAYLOAD',
	'STREAMING-UNSIGNED-PAYLOAD-TRAILER'
]);

function assertSupportedPayloadMode(request: Request): void {
	const mode = request.headers.get('x-amz-content-sha256');
	if (
		mode !== null &&
		!fixedPayloadDigestPattern.test(mode) &&
		!supportedPayloadModes.has(mode)
	) {
		throw new UnsupportedPayloadModeError();
	}
}

function areSignaturesEqual(left: string, right: string): boolean {
	return areStringsEqual(left, right);
}

function areStringsEqual(left: string, right: string): boolean {
	// Include the length difference in the accumulator and scan every character
	// in the longer string. This avoids returning at the first differing
	// character.
	const length = Math.max(left.length, right.length);
	let mismatch = left.length ^ right.length;

	for (let index = 0; index < length; index++) {
		mismatch |=
			(left.codePointAt(index) ?? 0) ^ (right.codePointAt(index) ?? 0);
	}

	return mismatch === 0;
}
