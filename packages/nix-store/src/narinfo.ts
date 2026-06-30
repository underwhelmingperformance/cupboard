import { z } from 'zod';

import { base64ToBytes } from './encoding.ts';
import { MalformedNarInfoLineError } from './errors.ts';
import { NixSha256Hash } from './hash.ts';
import {
	compressionSchema,
	hasControlCharacter,
	nixSha256HashSchema,
	referencesSchema,
	type StorePathBasename,
	storePathSchema
} from './scalars.ts';
import { byCodeUnit, StorePath } from './store-path.ts';

export interface NarInfoFields {
	readonly storePath: string;
	readonly url: string;
	readonly compression: 'zstd';
	readonly fileHash: string;
	readonly fileSize: number;
	readonly narHash: string;
	readonly narSize: number;
	readonly references: readonly string[];
	readonly deriver?: string;
	readonly ca?: string;
	readonly sigs: readonly string[];
}

// A narinfo is a sequence of `Key: value` lines. Most keys appear once; `Sig`
// may repeat. The lexer collects raw values per key, splitting on either line
// ending, and a malformed line (no separator) is the only failure it owns —
// every other rule belongs to the schema.
export function parseFields(source: string): Record<string, string[]> {
	const fields: Record<string, string[]> = {};

	for (const line of source.split(/\r?\n/)) {
		if (line.trim() === '') {
			continue;
		}

		const separator = line.indexOf(':');

		if (separator === -1) {
			throw new MalformedNarInfoLineError(line);
		}

		const key = line.slice(0, separator);
		const value = line.slice(separator + 1).trim();

		(fields[key] ??= []).push(value);
	}

	return fields;
}

function single<S extends z.ZodType>(value: S) {
	return z.tuple([value]).transform(([parsed]) => parsed);
}

const narInfoInteger = z
	.tuple([z.string().regex(/^\d+$/)])
	.transform(([digits]) => Math.trunc(Number(digits)))
	.refine(Number.isSafeInteger);

const references = z
	.tuple([z.string()])
	.transform(([value]) => value.split(/\s+/).filter((entry) => entry !== ''))
	.pipe(referencesSchema);

const lineScalar = z.string().refine((value) => !hasControlCharacter(value));

const optionalText = z
	.tuple([lineScalar])
	.transform(([value]) => (value === '' ? undefined : value))
	.optional();

const narInfoFieldsSchema = z.object({
	storePath: storePathSchema,
	url: lineScalar,
	compression: compressionSchema,
	fileHash: nixSha256HashSchema,
	fileSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	narHash: nixSha256HashSchema,
	narSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	references: referencesSchema,
	deriver: lineScalar.optional(),
	ca: lineScalar.optional(),
	sigs: z.array(lineScalar)
});

export const narInfoSchema = z
	.object({
		StorePath: single(storePathSchema),
		URL: single(lineScalar),
		Compression: single(compressionSchema),
		FileHash: single(nixSha256HashSchema),
		FileSize: narInfoInteger,
		NarHash: single(nixSha256HashSchema),
		NarSize: narInfoInteger,
		References: references,
		Deriver: optionalText,
		CA: optionalText,
		Sig: z.array(lineScalar).default([])
	})
	.transform(
		(fields): NarInfoFields => ({
			storePath: fields.StorePath,
			url: fields.URL,
			compression: fields.Compression,
			fileHash: fields.FileHash,
			fileSize: fields.FileSize,
			narHash: fields.NarHash,
			narSize: fields.NarSize,
			references: fields.References,
			deriver: fields.Deriver,
			ca: fields.CA,
			sigs: fields.Sig
		})
	);

export function parseNarInfo(source: string): NarInfo {
	return NarInfo.fromFields(narInfoSchema.parse(parseFields(source)));
}

export class NarInfo {
	static fromFields(fields: NarInfoFields): NarInfo {
		const parsed = narInfoFieldsSchema.parse(fields);

		return new NarInfo(
			new StorePath(parsed.storePath),
			parsed.url,
			parsed.compression,
			NixSha256Hash.parse(parsed.fileHash),
			parsed.fileSize,
			NixSha256Hash.parse(parsed.narHash),
			parsed.narSize,
			parsed.references,
			parsed.deriver,
			parsed.ca,
			parsed.sigs
		);
	}

	static parse(source: string): NarInfo {
		return parseNarInfo(source);
	}

	constructor(
		public readonly storePath: StorePath,
		public readonly url: string,
		public readonly compression: 'zstd',
		public readonly fileHash: NixSha256Hash,
		public readonly fileSize: number,
		public readonly narHash: NixSha256Hash,
		public readonly narSize: number,
		public readonly references: readonly StorePathBasename[],
		public readonly deriver?: string,
		public readonly ca?: string,
		public readonly sigs: readonly string[] = []
	) {}

	withSignature(signature: string): NarInfo {
		return new NarInfo(
			this.storePath,
			this.url,
			this.compression,
			this.fileHash,
			this.fileSize,
			this.narHash,
			this.narSize,
			this.references,
			this.deriver,
			this.ca,
			[...this.sigs, signature]
		);
	}

	fingerprint(): string {
		return narFingerprint(
			this.storePath,
			this.narHash.toString(),
			this.narSize,
			this.references
		);
	}

	render(): string {
		const fields = narInfoFieldsSchema.parse(this.toFields());
		const lines = [
			`StorePath: ${fields.storePath}`,
			`URL: ${fields.url}`,
			`Compression: ${fields.compression}`,
			`FileHash: ${fields.fileHash}`,
			`FileSize: ${String(fields.fileSize)}`,
			`NarHash: ${fields.narHash}`,
			`NarSize: ${String(fields.narSize)}`,
			`References: ${fields.references.join(' ')}`
		];

		if (fields.deriver !== undefined && fields.deriver !== '') {
			lines.push(`Deriver: ${fields.deriver}`);
		}

		if (fields.ca !== undefined && fields.ca !== '') {
			lines.push(`CA: ${fields.ca}`);
		}

		for (const signature of fields.sigs) {
			lines.push(`Sig: ${signature}`);
		}

		return `${lines.join('\n')}\n`;
	}

	toFields(): NarInfoFields {
		return {
			storePath: this.storePath.value,
			url: this.url,
			compression: this.compression,
			fileHash: this.fileHash.toString(),
			fileSize: this.fileSize,
			narHash: this.narHash.toString(),
			narSize: this.narSize,
			references: this.references,
			deriver: this.deriver,
			ca: this.ca,
			sigs: this.sigs
		};
	}
}

// Nix's canonical fingerprint sorts the full reference store paths, so a
// signature never depends on the order the references arrive in.
function fingerprintReferenceStorePaths(
	storePath: StorePath,
	references: readonly StorePathBasename[]
): readonly string[] {
	const path = storePath.value;
	const separator = path.lastIndexOf('/');
	const storeDirectory =
		separator === -1 ? undefined : path.slice(0, separator);

	return references
		.map((reference) =>
			storeDirectory === undefined
				? reference
				: `${storeDirectory}/${reference}`
		)
		.toSorted(byCodeUnit);
}

/**
 * The Nix narinfo fingerprint a signature is computed over. It commits to the
 * uncompressed NAR (`narHash`/`narSize`) and the references alone, never the
 * compressed encoding, so it can be signed before a blob's file hash and size
 * are known.
 */
export function narFingerprint(
	storePath: StorePath,
	narHash: string,
	narSize: number,
	references: readonly StorePathBasename[]
): string {
	return [
		'1',
		storePath.value,
		narHash,
		String(narSize),
		fingerprintReferenceStorePaths(storePath, references).join(',')
	].join(';');
}

/**
 * Whether any of a narinfo's `Sig:` lines is a valid Ed25519 signature over its
 * fingerprint under one of the given `name:base64` public keys. The signature
 * binds the store path, NAR hash, size and references, so a verified narinfo can
 * be trusted as the cache's own statement about a path.
 */
export async function verifyNarInfoSignature(
	narInfo: NarInfo,
	publicKeys: readonly string[]
): Promise<boolean> {
	if (narInfo.sigs.length === 0) {
		return false;
	}

	const fingerprint = new TextEncoder().encode(narInfo.fingerprint());

	for (const publicKey of publicKeys) {
		const key = await crypto.subtle.importKey(
			'raw',
			toArrayBuffer(namedBytes(publicKey)),
			'Ed25519',
			false,
			['verify']
		);

		for (const signature of narInfo.sigs) {
			const isVerified = await crypto.subtle.verify(
				'Ed25519',
				key,
				toArrayBuffer(namedBytes(signature)),
				toArrayBuffer(fingerprint)
			);

			if (isVerified) {
				return true;
			}
		}
	}

	return false;
}

function namedBytes(value: string): Uint8Array {
	const separator = value.indexOf(':');

	if (separator <= 0) {
		throw new MalformedNarInfoLineError(
			`Expected a name:base64 value: ${value}`
		);
	}

	return base64ToBytes(value.slice(separator + 1));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer;
}
