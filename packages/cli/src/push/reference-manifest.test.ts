import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import { storePathSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { PublicationCollection } from './publication.ts';
import {
	parseReferenceManifest,
	ReferenceManifestInvalidError
} from './reference-manifest.ts';

const storePath = storePathSchema.parse(
	'/nix/store/11111111111111111111111111111111-app'
);
const source = 'https://cache.example.test/t/acme/reuse/release';
const hash = NixSha256Hash.fromDigest(Buffer.alloc(32)).toString();
const narinfo = NarInfo.fromFields({
	storePath,
	url: 'nar/app.nar.zst',
	compression: 'zstd',
	narHash: hash,
	narSize: 20,
	fileHash: hash,
	fileSize: 10,
	references: [],
	sigs: []
}).render();
const entry = { storePath, source, kind: 'intermediate', narinfo };

describe('parseReferenceManifest', () => {
	it('validates a snapshot and preserves target status when the path is also selected', () => {
		const references = parseReferenceManifest(
			JSON.stringify({ version: 1, paths: [entry] })
		);
		const publication = PublicationCollection.of({
			targets: [storePath],
			references
		});
		expect({
			references,
			entries: publication.entries,
			targets: publication.targetPaths
		}).toStrictEqual({
			references: [
				{
					storePath,
					kind: 'intermediate',
					source: new URL(source),
					metadata: {
						upload: {
							storePath,
							storePathHash: '11111111111111111111111111111111',
							narHash: hash,
							narSize: 20,
							fileHash: hash,
							fileSize: 10,
							compression: 'zstd',
							references: []
						},
						signatures: []
					}
				}
			],
			entries: [
				{
					storePath,
					kind: 'target',
					source: 'reference',
					reference: references[0]
				}
			],
			targets: [storePath]
		});
	});

	it.each([
		{ label: 'malformed JSON', contents: '{' },
		{
			label: 'duplicate paths',
			contents: JSON.stringify({ version: 1, paths: [entry, entry] })
		},
		{
			label: 'unexpected manifest fields',
			contents: JSON.stringify({ version: 1, paths: [entry], extra: true })
		},
		{
			label: 'unexpected entry fields',
			contents: JSON.stringify({
				version: 1,
				paths: [{ ...entry, extra: true }]
			})
		},
		{
			label: 'a different path in the narinfo',
			contents: JSON.stringify({
				version: 1,
				paths: [
					{
						...entry,
						storePath: '/nix/store/22222222222222222222222222222222-lib'
					}
				]
			})
		},
		{
			label: 'an invalid NAR hash',
			contents: JSON.stringify({
				version: 1,
				paths: [
					{
						...entry,
						narinfo: narinfo.replace(
							`NarHash: ${hash}`,
							'NarHash: sha256:invalid'
						)
					}
				]
			})
		},
		{
			label: 'an invalid compression',
			contents: JSON.stringify({
				version: 1,
				paths: [
					{
						...entry,
						narinfo: narinfo.replace(
							'Compression: zstd',
							'Compression: invalid'
						)
					}
				]
			})
		},
		{
			label: 'credentials in the source URL',
			contents: JSON.stringify({
				version: 1,
				paths: [
					{
						...entry,
						source: 'https://reader:secret@cache.example.test/t/acme'
					}
				]
			})
		},
		{
			label: 'a non-HTTP source URL',
			contents: JSON.stringify({
				version: 1,
				paths: [{ ...entry, source: 'file:///cache' }]
			})
		}
	])('rejects $label', ({ contents }) => {
		expect(() => parseReferenceManifest(contents)).toThrow(
			ReferenceManifestInvalidError
		);
	});
});
