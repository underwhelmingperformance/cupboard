import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { RemoteBodyTooLargeError } from '@cupboard/shared/response-body';
import { describe, expect, it } from 'vitest';

import { NarInfoUnavailableError, NarInfoUnparsableError } from '../errors.ts';
import {
	accessKeyAuthorization,
	destinationAccessKey
} from '../test-support.ts';

import { fetchReferenceMetadata } from './reference.ts';

const storePathHash = storePathHashSchema.parse(
	'0123456789abcdfghijklmnpqrsvwxyz'
);
const storePath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-example';
const fileHash = 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk';
const narHash = 'sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk';
const signature = `cupboard-1:${Buffer.alloc(64, 1).toString('base64')}`;

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
	it('rejects an oversized narinfo before parsing it', async () => {
		await expect(
			fetchReferenceMetadata(
				{ url: new URL('https://cache.example.workers.dev/') },
				storePathHash,
				{
					fetch: respondingFetcher(
						[],
						() =>
							new Response(narInfoText(), {
								headers: { 'content-length': String(1024 * 1024 + 1) }
							})
					)
				}
			)
		).rejects.toBeInstanceOf(RemoteBodyTooLargeError);
	});

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
								`Sig: ${signature}`
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
				signatures: [signature]
			},
			requests: [
				{
					url: `https://cache.example.workers.dev/t/acme/${storePathHash}.narinfo`,
					authorization: undefined
				}
			]
		});
	});

	// Nix reads the mark as part of the first field name, so it ignores that line.
	it.each([
		{ name: 'absent from the narinfo', body: narInfoText() },
		{
			name: 'only after a byte order mark',
			body: `\u{FEFF}CA: fixed:r:sha256:${fileHash.slice('sha256:'.length)}\n${narInfoText()}`
		}
	])('omits optional upload metadata $name', async ({ body }) => {
		const metadata = await fetchReferenceMetadata(
			{ url: new URL('https://cache.example.workers.dev/t/acme') },
			storePathHash,
			{ fetch: respondingFetcher([], () => respond(body)) }
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

	it('presents the access key in the Basic authorization header', async () => {
		const requests: RecordedRequest[] = [];

		await fetchReferenceMetadata(
			{
				url: new URL('https://cache.example.workers.dev/t/acme'),
				accessKey: destinationAccessKey
			},
			storePathHash,
			{ fetch: respondingFetcher(requests, () => respond(narInfoText())) }
		);

		expect(requests).toStrictEqual([
			{
				url: `https://cache.example.workers.dev/t/acme/${storePathHash}.narinfo`,
				authorization: accessKeyAuthorization(destinationAccessKey)
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
			name: 'a narinfo after a byte order mark',
			body: `\u{FEFF}${narInfoText()}`
		},
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
});

function respond(body: string): Response {
	return new Response(body, { status: 200 });
}
