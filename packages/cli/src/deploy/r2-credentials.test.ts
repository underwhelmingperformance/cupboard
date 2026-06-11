import { describe, expect, it } from 'vitest';

import {
	accessKeyIdProblem,
	checkR2Credentials,
	secretAccessKeyProblem
} from './r2-credentials.ts';

const options = {
	accountId: 'acc-hex',
	bucketName: 'cupboard-blobs',
	credentials: {
		accessKeyId: 'a'.repeat(32),
		secretAccessKey: 'b'.repeat(64)
	}
};

function respondingWith(status: number): {
	fetcher: typeof fetch;
	requests: Request[];
} {
	const requests: Request[] = [];

	const fetcher: typeof fetch = (input, init) => {
		requests.push(new Request(input, init));

		return Promise.resolve(new Response(undefined, { status }));
	};

	return { fetcher, requests };
}

describe('checkR2Credentials', () => {
	it.each([
		['an existing probe object', 200],
		['a missing object or bucket', 404]
	])('accepts %s as proof of valid credentials', async (_name, status) => {
		const { fetcher } = respondingWith(status);

		expect(await checkR2Credentials(options, fetcher)).toStrictEqual({
			kind: 'valid'
		});
	});

	it.each([[401], [403]])('reports a %i as rejected', async (status) => {
		const { fetcher } = respondingWith(status);

		expect(await checkR2Credentials(options, fetcher)).toStrictEqual({
			kind: 'rejected',
			status
		});
	});

	it('signs a HEAD against the bucket on the account R2 endpoint', async () => {
		const { fetcher, requests } = respondingWith(404);

		await checkR2Credentials(options, fetcher);
		const request = requests[0];

		expect({
			method: request?.method,
			url: request?.url,
			signed: request?.headers
				.get('authorization')
				?.startsWith('AWS4-HMAC-SHA256 Credential=')
		}).toStrictEqual({
			method: 'HEAD',
			url: 'https://acc-hex.r2.cloudflarestorage.com/cupboard-blobs/.cupboard-credential-probe',
			signed: true
		});
	});

	it('reports a network failure as unreachable', async () => {
		const cause = new Error('offline');
		const fetcher: typeof fetch = () => Promise.reject(cause);

		expect(await checkR2Credentials(options, fetcher)).toStrictEqual({
			kind: 'unreachable',
			cause
		});
	});
});

describe('credential shape problems', () => {
	it.each([
		['a'.repeat(32), undefined],
		['A0'.repeat(16), undefined],
		['too-short', 'an R2 access key id is 32 hex characters (the API token id)']
	])('access key id %s -> %s', (value, problem) => {
		expect(accessKeyIdProblem(value)).toBe(problem);
	});

	it.each([
		['b'.repeat(64), undefined],
		['zz'.repeat(32), 'an R2 secret access key is 64 hex characters']
	])('secret %s -> %s', (value, problem) => {
		expect(secretAccessKeyProblem(value)).toBe(problem);
	});
});
