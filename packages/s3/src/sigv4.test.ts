import { AwsV4Signer } from 'aws4fetch';
import { describe, expect, it } from 'vitest';

import {
	ClockSkewExceededError,
	InvalidAmzExpiresError,
	PresignedUrlExpiredError,
	SignatureDoesNotMatchError
} from './errors.ts';
import type { CredentialResolver, ResolvedCredential } from './ports.ts';
import { isSigned, verifySignature } from './sigv4.ts';

const accessKeyId = 'AKIDEXAMPLE';
const secretAccessKey = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';

const principal = {
	accessKeyId,
	tenant: 'acme',
	cache: 'default',
	grants: ['upload:commit'],
	credentialId: 'cred-1',
	label: 'nixbuild'
};

function resolverFor(
	keys: Record<string, ResolvedCredential>
): CredentialResolver {
	return {
		resolve: (id) => Promise.resolve(keys[id])
	};
}

const resolver = resolverFor({
	[accessKeyId]: { secretAccessKey, principal }
});

// The fixtures are signed at this instant; header-signed requests are checked
// against a clock-skew window, so verification runs as of the signing time.
const signedAt = new Date('2015-08-30T12:36:00Z');

async function signedRequest(options: {
	readonly method: string;
	readonly url: string;
	readonly headers?: Record<string, string>;
	readonly body?: string;
	readonly signQuery?: boolean;
}): Promise<Request> {
	const signer = new AwsV4Signer({
		method: options.method,
		url: options.url,
		headers: options.headers,
		body: options.body,
		accessKeyId,
		secretAccessKey,
		service: 's3',
		region: 'auto',
		datetime: '20150830T123600Z',
		signQuery: options.signQuery
	});

	const signed = await signer.sign();
	return new Request(signed.url.toString(), {
		method: options.method,
		headers: signed.headers,
		body: options.body ?? undefined
	});
}

describe('isSigned', () => {
	it('detects header and presigned signatures and bare requests', () => {
		expect(isSigned(new Request('https://s3.example.com/b/k'))).toBe(false);
		expect(
			isSigned(
				new Request('https://s3.example.com/b/k', {
					headers: { authorization: 'AWS4-HMAC-SHA256 ...' }
				})
			)
		).toBe(true);
		expect(
			isSigned(
				new Request(
					'https://s3.example.com/b/k?X-Amz-Algorithm=AWS4-HMAC-SHA256'
				)
			)
		).toBe(true);
	});
});

describe('verifySignature', () => {
	it('accepts the AWS get-vanilla test-suite vector', async () => {
		const request = new Request('https://example.amazonaws.com/', {
			method: 'GET',
			headers: {
				'x-amz-date': '20150830T123600Z',
				authorization:
					'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
			}
		});

		await expect(
			verifySignature(request, resolver, { now: signedAt })
		).resolves.toStrictEqual(principal);
	});

	it('accepts a header-signed PUT and returns the principal', async () => {
		const request = await signedRequest({
			method: 'PUT',
			url: 'https://s3.example.com/acme/abc.narinfo',
			headers: { 'content-type': 'text/x-nix-narinfo' },
			body: 'StorePath: /nix/store/x\n'
		});

		await expect(
			verifySignature(request, resolver, { now: signedAt })
		).resolves.toStrictEqual(principal);
	});

	it('accepts an explicit x-amz-content-sha256 digest', async () => {
		const request = await signedRequest({
			method: 'PUT',
			url: 'https://s3.example.com/acme/nar/abc.nar.zst',
			headers: {
				'x-amz-content-sha256':
					'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
			}
		});

		await expect(
			verifySignature(request, resolver, { now: signedAt })
		).resolves.toStrictEqual(principal);
	});

	it('rejects a header-signed request outside the clock-skew window', async () => {
		const request = await signedRequest({
			method: 'GET',
			url: 'https://s3.example.com/acme/abc.narinfo'
		});

		await expect(
			verifySignature(request, resolver, {
				now: new Date('2015-08-30T13:00:00Z')
			})
		).rejects.toThrow(ClockSkewExceededError);
	});

	it('accepts a presigned (query) signature', async () => {
		const request = await signedRequest({
			method: 'GET',
			url: 'https://s3.example.com/acme/abc.narinfo?X-Amz-Expires=900',
			signQuery: true
		});

		await expect(
			verifySignature(request, resolver, {
				now: new Date('2015-08-30T12:40:00Z')
			})
		).resolves.toStrictEqual(principal);
	});

	it('rejects a tampered request', async () => {
		const request = await signedRequest({
			method: 'PUT',
			url: 'https://s3.example.com/acme/abc.narinfo',
			body: 'original'
		});
		const tampered = new Request('https://s3.example.com/acme/OTHER.narinfo', {
			method: 'PUT',
			headers: request.headers
		});

		await expect(
			verifySignature(tampered, resolver, { now: signedAt })
		).rejects.toThrow(SignatureDoesNotMatchError);
	});

	it('rejects an unknown access key', async () => {
		const request = await signedRequest({
			method: 'GET',
			url: 'https://s3.example.com/acme/abc.narinfo'
		});

		await expect(verifySignature(request, resolverFor({}))).rejects.toThrow(
			SignatureDoesNotMatchError
		);
	});

	it('rejects the wrong secret', async () => {
		const request = await signedRequest({
			method: 'GET',
			url: 'https://s3.example.com/acme/abc.narinfo'
		});

		await expect(
			verifySignature(
				request,
				resolverFor({
					[accessKeyId]: { secretAccessKey: 'wrong-secret', principal }
				}),
				{ now: signedAt }
			)
		).rejects.toThrow(SignatureDoesNotMatchError);
	});

	it('rejects an expired presigned URL', async () => {
		const request = await signedRequest({
			method: 'GET',
			url: 'https://s3.example.com/acme/abc.narinfo?X-Amz-Expires=900',
			signQuery: true
		});

		await expect(
			verifySignature(request, resolver, {
				now: new Date('2020-01-01T00:00:00Z')
			})
		).rejects.toThrow(PresignedUrlExpiredError);
	});

	// The expiry bounds are evaluated before the signature, so an out-of-range
	// `X-Amz-Expires` is rejected as malformed regardless of the (broken) signature
	// left behind when the value is overridden.
	it.each<{ name: string; expires: string | undefined }>([
		{ name: 'absent', expires: undefined },
		{ name: 'zero', expires: '0' },
		{ name: 'beyond the one-week maximum', expires: '999999999' }
	])('rejects a presigned URL whose expiry is $name', async ({ expires }) => {
		const signed = await signedRequest({
			method: 'GET',
			url: 'https://s3.example.com/acme/abc.narinfo?X-Amz-Expires=900',
			signQuery: true
		});

		const url = new URL(signed.url);
		if (expires === undefined) {
			url.searchParams.delete('X-Amz-Expires');
		} else {
			url.searchParams.set('X-Amz-Expires', expires);
		}

		const request = new Request(url.href);
		await expect(
			verifySignature(request, resolver, { now: signedAt })
		).rejects.toThrow(InvalidAmzExpiresError);
	});
});
