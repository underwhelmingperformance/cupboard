import { offerFromNarInfo } from '@cupboard/nix-store/narinfo-reader';
import { type StorePathString } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { referencePublicationManifestSchema } from '@cupboard/protocol/upload';

import { parseWorkerUrl } from '../client/transport.ts';
import { CliError, CliUsageError } from '../errors.ts';

import { parseReferenceMetadata, type ReferenceMetadata } from './reference.ts';

export interface PreparedReference {
	readonly storePath: StorePathString;
	readonly kind: 'target' | 'intermediate';
	readonly source: URL;
	readonly metadata: ReferenceMetadata;
}

export class ReferenceManifestInvalidError extends CliUsageError {
	constructor(reason: string) {
		super(`The reference manifest is invalid: ${reason}`);
		this.name = 'ReferenceManifestInvalidError';
	}
}

export class ReferenceSnapshotDivergedError extends CliError {
	constructor(
		public readonly storePath: StorePathString,
		public readonly expectedNarHash: string,
		public readonly cacheNarHash: string
	) {
		super(
			`The destination cache serves ${storePath} with NAR hash ` +
				`${cacheNarHash}, but the reference manifest specifies ${expectedNarHash}. ` +
				'Refresh the reference manifest before publishing the runtime closure.'
		);
		this.name = 'ReferenceSnapshotDivergedError';
	}
}

export function parseReferenceManifest(
	contents: string
): readonly PreparedReference[] {
	try {
		const manifest = referencePublicationManifestSchema.parse(
			JSON.parse(contents)
		);
		return manifest.paths.map((entry) => {
			offerFromNarInfo(
				entry.narinfo,
				entry.storePath,
				new StorePath(entry.storePath).storeDirectory
			);
			let source: URL;
			try {
				source = parseWorkerUrl(entry.source);
			} catch {
				throw new ReferenceManifestInvalidError(
					`invalid source URL for ${entry.storePath}`
				);
			}
			return {
				storePath: entry.storePath,
				kind: entry.kind,
				source,
				metadata: parseReferenceMetadata(entry.narinfo)
			};
		});
	} catch (error) {
		if (error instanceof ReferenceManifestInvalidError) {
			throw error;
		}
		throw new ReferenceManifestInvalidError(String(error));
	}
}
