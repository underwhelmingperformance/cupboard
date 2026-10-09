import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { describe, expect, it } from 'vitest';

import {
	tenantDependencyReferences,
	tenantReferenceSources
} from './tenant-publication.ts';

const profile = storePathSchema.parse(`/nix/store/${'1'.repeat(32)}-profile`);
const wrapper = storePathSchema.parse(`/nix/store/${'2'.repeat(32)}-wrapper`);
const client = storePathSchema.parse(`/nix/store/${'3'.repeat(32)}-deploy-rs`);
const upstream = storePathSchema.parse(`/nix/store/${'4'.repeat(32)}-upstream`);
const unrelated = storePathSchema.parse(
	`/nix/store/${'5'.repeat(32)}-unrelated`
);
const destination = new URL('https://cache.example.test/t/acme');
const reuse = new URL('https://cache.example.test/t/acme/reuse/prs');

function narinfo(storePath: StorePathString): string {
	return `StorePath: ${storePath}\nURL: nar/file.nar\nCompression: none\nFileHash: sha256:${'0'.repeat(64)}\nFileSize: 1\nNarHash: sha256:${'0'.repeat(64)}\nNarSize: 1\nReferences: \n`;
}

function fetcher(
	requests: string[],
	holdings: ReadonlyMap<string, readonly StorePathString[]>
): typeof fetch {
	return (input) => {
		const url = new URL(input instanceof Request ? input.url : input);
		requests.push(url.href);
		const available =
			holdings.get(url.href.slice(0, url.href.lastIndexOf('/'))) ?? [];
		const path = available.find((path) =>
			url.pathname.endsWith(`/${StorePath.hash(path)}.narinfo`)
		);
		return Promise.resolve(
			path === undefined
				? new Response(undefined, { status: 404 })
				: new Response(narinfo(path))
		);
	};
}

describe('tenantDependencyReferences', () => {
	it.each([false, true])(
		'publishes required tenant dependencies without querying unrelated paths, target cached: %s',
		async (cached) => {
			const requests: string[] = [];
			const references = await tenantDependencyReferences(
				[wrapper, client, upstream, wrapper],
				{
					sources: [
						{ url: destination, paths: [] },
						{ url: reuse, paths: [] }
					],
					fetch: fetcher(
						requests,
						new Map([
							[destination.href, [wrapper]],
							[reuse.href, [client, unrelated, ...(cached ? [profile] : [])]]
						])
					)
				}
			);
			expect({
				references,
				requests: requests.toSorted((a, b) => a.localeCompare(b))
			}).toStrictEqual({
				references: [
					{
						storePath: wrapper,
						source: destination.href,
						narinfo: narinfo(wrapper),
						kind: 'intermediate'
					},
					{
						storePath: client,
						source: reuse.href,
						narinfo: narinfo(client),
						kind: 'intermediate'
					}
				],
				requests: [
					...[wrapper, client, upstream].map(
						(path) => `${destination.href}/${StorePath.hash(path)}.narinfo`
					),
					...[client, upstream].map(
						(path) => `${reuse.href}/${StorePath.hash(path)}.narinfo`
					)
				].toSorted((a, b) => a.localeCompare(b))
			});
		}
	);
	it('keeps an empty tenant cache empty without any additional work', async () => {
		const requests: string[] = [];
		const references = await tenantDependencyReferences([client], {
			sources: [{ url: destination, paths: [] }],
			fetch: fetcher(requests, new Map())
		});
		expect({ references, requests }).toStrictEqual({
			references: [],
			requests: [`${destination.href}/${StorePath.hash(client)}.narinfo`]
		});
	});
});

it('includes configured tenant read caches and reuse views in destination-first order', () => {
	const read = 'https://cache.example.test/t/acme/cache/pr-42';
	const sources = tenantReferenceSources(
		destination,
		[
			{ url: destination, paths: [] },
			{ url: reuse, paths: [] }
		],
		[
			read + '?priority=20',
			reuse.href,
			'https://cache.example.test/t/other/cache/pr-42',
			'https://cache.nixos.org',
			'local'
		]
	);
	expect(sources.map((source) => source.url.href)).toStrictEqual([
		destination.href,
		reuse.href,
		read
	]);
});
