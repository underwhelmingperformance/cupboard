import { AwsV4Signer } from 'aws4fetch';
import { describe, expect, it } from 'vitest';

import {
	ClockSkewExceededError,
	InvalidAmzDateError,
	InvalidAmzExpiresError,
	MalformedCredentialScopeError,
	PresignedUrlExpiredError,
	RequestNotYetValidError,
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
	readonly datetime?: string;
	readonly sessionToken?: string;
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
		datetime: options.datetime ?? '20150830T123600Z',
		signQuery: options.signQuery,
		sessionToken: options.sessionToken
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
	it('accepts a header-signed GET', async () => {
		const request = await signedRequest({
			method: 'GET',
			url: 'https://s3.example.com/acme/abc.narinfo'
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

	it('accepts a payload digest that is not included in SignedHeaders', async () => {
		const digest =
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
		const headers = new Headers({
			'x-amz-content-sha256': digest,
			'x-amz-date': '20150830T123600Z'
		});
		const canonicalSigner = new AwsV4Signer({
			method: 'PUT',
			url: 'https://s3.example.com/acme/nar/abc.nar.zst',
			headers,
			accessKeyId,
			secretAccessKey,
			service: 's3',
			region: 'auto',
			datetime: '20150830T123600Z',
			allHeaders: true
		});

		// aws4fetch normally includes the payload-hash header in SignedHeaders.
		// Remove that one canonical header to construct the form AWS also permits.
		canonicalSigner.signableHeaders = ['host', 'x-amz-date'];
		canonicalSigner.signedHeaders = 'host;x-amz-date';
		canonicalSigner.canonicalHeaders = canonicalSigner.canonicalHeaders
			.split('\n')
			.filter((line) => !line.startsWith('x-amz-content-sha256:'))
			.join('\n');
		headers.set(
			'authorization',
			`AWS4-HMAC-SHA256 Credential=${accessKeyId}/20150830/auto/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=${await canonicalSigner.signature()}`
		);

		await expect(
			verifySignature(
				new Request(canonicalSigner.url, { method: 'PUT', headers }),
				resolver,
				{ now: signedAt }
			)
		).resolves.toStrictEqual(principal);
	});

	it.each([false, true])(
		'rejects a credential scope for another service when signQuery is %s',
		async (signQuery) => {
			const signer = new AwsV4Signer({
				method: 'GET',
				url: signQuery
					? 'https://s3.example.com/acme/abc.narinfo?X-Amz-Expires=900'
					: 'https://s3.example.com/acme/abc.narinfo',
				accessKeyId,
				secretAccessKey,
				service: 'execute-api',
				region: 'auto',
				datetime: '20150830T123600Z',
				signQuery
			});
			const signed = await signer.sign();
			const request = new Request(signed.url, {
				method: 'GET',
				headers: signed.headers
			});

			await expect(
				verifySignature(request, resolver, { now: signedAt })
			).rejects.toThrow(MalformedCredentialScopeError);
		}
	);

	it.each([false, true])(
		'accepts the required session token when signQuery is %s',
		async (signQuery) => {
			const sessionToken = 'temporary-session-token';
			const request = await signedRequest({
				method: 'GET',
				url: signQuery
					? 'https://s3.example.com/acme/abc.narinfo?X-Amz-Expires=900'
					: 'https://s3.example.com/acme/abc.narinfo',
				signQuery,
				sessionToken
			});
			const temporaryResolver = resolverFor({
				[accessKeyId]: { secretAccessKey, sessionToken, principal }
			});

			await expect(
				verifySignature(request, temporaryResolver, { now: signedAt })
			).resolves.toStrictEqual(principal);
		}
	);

	it.each([
		{ name: 'missing header', signQuery: false, requestToken: undefined },
		{
			name: 'different header',
			signQuery: false,
			requestToken: 'different-session-token'
		},
		{
			name: 'missing query parameter',
			signQuery: true,
			requestToken: undefined
		},
		{
			name: 'different query parameter',
			signQuery: true,
			requestToken: 'different-session-token'
		}
	])(
		'rejects a $name for a temporary credential',
		async ({ requestToken, signQuery }) => {
			const sessionToken = 'temporary-session-token';
			const request = await signedRequest({
				method: 'GET',
				url: signQuery
					? 'https://s3.example.com/acme/abc.narinfo?X-Amz-Expires=900'
					: 'https://s3.example.com/acme/abc.narinfo',
				signQuery,
				sessionToken: requestToken
			});
			const temporaryResolver = resolverFor({
				[accessKeyId]: { secretAccessKey, sessionToken, principal }
			});

			await expect(
				verifySignature(request, temporaryResolver, { now: signedAt })
			).rejects.toThrow(SignatureDoesNotMatchError);
		}
	);

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

	it.each([
		'20150229T123600Z',
		'20151301T123600Z',
		'20150830T243600Z',
		'20150830T126000Z'
	])('rejects the invalid calendar timestamp %s', async (datetime) => {
		const request = await signedRequest({
			method: 'GET',
			url: 'https://s3.example.com/acme/abc.narinfo',
			datetime
		});

		await expect(
			verifySignature(request, resolver, { now: signedAt })
		).rejects.toThrow(InvalidAmzDateError);
	});

	it.each([false, true])(
		'rejects a future-dated request when signQuery is %s',
		async (signQuery) => {
			const request = await signedRequest({
				method: 'GET',
				url: signQuery
					? 'https://s3.example.com/acme/abc.narinfo?X-Amz-Expires=900'
					: 'https://s3.example.com/acme/abc.narinfo',
				signQuery,
				datetime: '20150830T123601Z'
			});

			await expect(
				verifySignature(request, resolver, { now: signedAt })
			).rejects.toThrow(RequestNotYetValidError);
		}
	);

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

	// Expiry validation runs before signature verification. Changing or removing
	// `X-Amz-Expires` invalidates the signature, but an out-of-range value still
	// produces `InvalidAmzExpiresError` first.
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
