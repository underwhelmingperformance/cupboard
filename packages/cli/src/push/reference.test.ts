import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { readUserSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';

import {
	NarInfoUnavailableError,
	NarInfoUnparsableError,
	ReadCredentialPairError
} from '../errors.ts';

import { fetchReferenceMetadata } from './reference.ts';

const storePathHash = storePathHashSchema.parse(
	'0123456789abcdfghijklmnpqrsvwxyz'
);
const storePath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example';
const fileHash = 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk';
const narHash = 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk';

function narInfoText(
	overrides: { readonly optionalLines?: readonly string[] } = {}
): string {
	return [
		`StorePath: ${storePath}`,
		'URL: nar/example.nar.zst',
		'Compression: zstd',
		`FileHash: ${fileHash}`,
		'FileSize: 123',
		`NarHash: ${narHash}`,
		'NarSize: 456',
		'References: 1123456789abcdfghijklmnpqrsvwxyz-second 0123456789abcdfghijklmnpqrsvwxyz-first',
		...(overrides.optionalLines ?? []),
		''
	].join('\n');
}

interface RecordedRequest {
	readonly url: string;
	readonly authorization: string | undefined;
}

function requestHref(input: Parameters<typeof fetch>[0]): string {
	if (input instanceof URL) {
		return input.href;
	}

	return typeof input === 'string' ? input : input.url;
}

function respondingFetcher(
	requests: RecordedRequest[],
	response: () => Response
): typeof fetch {
	return (input, init) => {
		const headers = new Headers(init?.headers);
		requests.push({
			url: requestHref(input),
			authorization: headers.get('authorization') ?? undefined
		});

		return Promise.resolve(response());
	};
}

describe('fetchReferenceMetadata', () => {
	it('maps a served narinfo to upload metadata and retains its signatures', async () => {
		const requests: RecordedRequest[] = [];
		const metadata = await fetchReferenceMetadata(
			{ url: new URL('https://cache.example.workers.dev/t/acme/') },
			storePathHash,
			{
				fetch: respondingFetcher(requests, () =>
					respond(
						narInfoText({
							optionalLines: [
								'Deriver: d123456789abcdfghijklmnpqrsvwxyz-example.drv',
								'CA: fixed:r:sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
								'Sig: cupboard-1:signature'
							]
						})
					)
				)
			}
		);

		expect({ metadata, requests }).toStrictEqual({
			metadata: {
				upload: {
					storePathHash,
					storePath,
					narHash,
					narSize: 456,
					references: [
						'0123456789abcdfghijklmnpqrsvwxyz-first',
						'1123456789abcdfghijklmnpqrsvwxyz-second'
					],
					deriver: 'd123456789abcdfghijklmnpqrsvwxyz-example.drv',
					ca: 'fixed:r:sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
					fileHash,
					fileSize: 123,
					compression: 'zstd'
				},
				signatures: ['cupboard-1:signature']
			},
			requests: [
				{
					url: `https://cache.example.workers.dev/t/acme/${storePathHash}.narinfo`,
					authorization: undefined
				}
			]
		});
	});

	it('omits optional upload metadata absent from the narinfo', async () => {
		const metadata = await fetchReferenceMetadata(
			{ url: new URL('https://cache.example.workers.dev/t/acme') },
			storePathHash,
			{ fetch: respondingFetcher([], () => respond(narInfoText())) }
		);

		expect(metadata).toStrictEqual({
			upload: {
				storePathHash,
				storePath,
				narHash,
				narSize: 456,
				references: [
					'0123456789abcdfghijklmnpqrsvwxyz-first',
					'1123456789abcdfghijklmnpqrsvwxyz-second'
				],
				fileHash,
				fileSize: 123,
				compression: 'zstd'
			},
			signatures: []
		});
	});

	it('sends the read username and password in the Basic authorization header', async () => {
		const requests: RecordedRequest[] = [];

		await fetchReferenceMetadata(
			{
				url: new URL('https://cache.example.workers.dev/t/acme'),
				readUser: readUserSchema.parse('reader'),
				readPassword: 'secret'
			},
			storePathHash,
			{ fetch: respondingFetcher(requests, () => respond(narInfoText())) }
		);

		expect(requests).toStrictEqual([
			{
				url: `https://cache.example.workers.dev/t/acme/${storePathHash}.narinfo`,
				authorization: `Basic ${Buffer.from('reader:secret').toString('base64')}`
			}
		]);
	});

	it.each([
		{ name: 'a missing narinfo', status: 404 },
		{ name: 'a refused read', status: 403 }
	])(
		'returns an unavailable error with the response status for $name',
		async ({ status }) => {
			let error: unknown;
			try {
				await fetchReferenceMetadata(
					{ url: new URL('https://cache.example.workers.dev/t/acme') },
					storePathHash,
					{
						fetch: respondingFetcher(
							[],
							() => new Response('absent', { status })
						)
					}
				);
			} catch (error_: unknown) {
				error = error_;
			}

			expect(error).toBeInstanceOf(NarInfoUnavailableError);

			if (!(error instanceof NarInfoUnavailableError)) {
				return;
			}

			expect({
				name: error.name,
				target: error.target.href,
				status: error.status
			}).toStrictEqual({
				name: 'NarInfoUnavailableError',
				target: `https://cache.example.workers.dev/t/acme/${storePathHash}.narinfo`,
				status
			});
		}
	);

	it.each([
		{ name: 'a body with no separators', body: 'not a narinfo' },
		{
			name: 'a narinfo whose store path is outside the store',
			body: narInfoText().replace(storePath, '/tmp/example')
		}
	])('returns an unparsable error for $name', async ({ body }) => {
		let error: unknown;
		try {
			await fetchReferenceMetadata(
				{ url: new URL('https://cache.example.workers.dev/t/acme') },
				storePathHash,
				{ fetch: respondingFetcher([], () => respond(body)) }
			);
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(NarInfoUnparsableError);

		if (!(error instanceof NarInfoUnparsableError)) {
			return;
		}

		expect({ name: error.name, target: error.target.href }).toStrictEqual({
			name: 'NarInfoUnparsableError',
			target: `https://cache.example.workers.dev/t/acme/${storePathHash}.narinfo`
		});
	});

	it('rejects incomplete read credentials', async () => {
		let error: unknown;
		try {
			await fetchReferenceMetadata(
				{
					url: new URL('https://cache.example.workers.dev/t/acme'),
					readUser: readUserSchema.parse('reader')
				},
				storePathHash,
				{ fetch: respondingFetcher([], () => respond(narInfoText())) }
			);
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(ReadCredentialPairError);
	});
});

function respond(body: string): Response {
	return new Response(body, { status: 200 });
}
