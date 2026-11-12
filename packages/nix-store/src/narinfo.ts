import { z } from 'zod';

import { MalformedNarInfoLineError } from './errors.ts';
import { NixSha256Hash } from './hash.ts';
import {
	boundedReferencesSchema,
	compressionSchema,
	hasControlCharacter,
	type NixFingerprint,
	nixFingerprintSchema,
	nixSha256HashSchema,
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
// ending. The lexer reports only one failure, a line with no separator; every
// other rule belongs to the schema.
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

/**
The size given by a narinfo `FileSize` or `NarSize` field, or `undefined`
when the value is not a size. Nix converts the whole value, so any character
other than a digit makes it invalid. A value above `Number.MAX_SAFE_INTEGER`
is rejected too, since this reader counts sizes in JavaScript numbers.
*/
export function narInfoSize(value: string): number | undefined {
	if (!/^\d+$/u.test(value)) {
		return undefined;
	}

	const size = Number(value);

	return Number.isSafeInteger(size) ? size : undefined;
}

const narInfoInteger = z.tuple([z.string()]).transform(([digits], ctx) => {
	const size = narInfoSize(digits);

	if (size === undefined) {
		ctx.addIssue({
			code: 'custom',
			message: `not a narinfo size: ${digits}`
		});

		return z.NEVER;
	}

	return size;
});

// Nix reads the references into a set, so a repeated reference counts once and
// the references come in the set's order.
const references = z
	.tuple([z.string()])
	.transform(([value]) =>
		[...new Set(value.split(/\s+/).filter((entry) => entry !== ''))].toSorted(
			byCodeUnit
		)
	)
	.pipe(boundedReferencesSchema);

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
	references: boundedReferencesSchema,
	deriver: lineScalar.optional(),
	ca: lineScalar.optional(),
	sigs: z.array(lineScalar)
});

const narInfoRecords = z.object({
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
});

function toNarInfoFields(
	fields: z.output<typeof narInfoRecords>
): NarInfoFields {
	return {
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
	};
}

export const narInfoSchema = narInfoRecords.transform(toNarInfoFields);

// A stored row can repeat a reference, because `referencesSchema` did not
// refuse repeats when the row was written. `NarInfo.render` accepts it.
const storedNarInfoSchema = narInfoRecords
	.extend({
		References: z
			.tuple([z.string()])
			.transform(([value]) =>
				value.split(/\s+/).filter((entry) => entry !== '')
			)
			.pipe(boundedReferencesSchema)
	})
	.transform(toNarInfoFields);

export function parseNarInfo(source: string): NarInfo {
	return NarInfo.fromFields(narInfoSchema.parse(parseFields(source)));
}

/**
Parses a narinfo that this server rendered from a stored row. A row can be
older than the rules that apply to new input. This reads such a narinfo as
`NarInfo.render` writes it, so the server can serve what it already stores.
*/
function parseStoredNarInfo(source: string): NarInfo {
	return NarInfo.fromFields(storedNarInfoSchema.parse(parseFields(source)));
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

	static parseStored(source: string): NarInfo {
		return parseStoredNarInfo(source);
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

	fingerprint(): NixFingerprint {
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
			`References: ${fields.references.join(' ')}`,
			...(fields.deriver === undefined || fields.deriver === ''
				? []
				: [`Deriver: ${fields.deriver}`]),
			...(fields.ca === undefined || fields.ca === ''
				? []
				: [`CA: ${fields.ca}`]),
			...fields.sigs.map((signature) => `Sig: ${signature}`)
		];

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

// Nix prints the references as a sorted set of full store paths, so a
// signature depends neither on the order the references arrive in nor on a
// repeated reference.
function fingerprintReferenceStorePaths(
	storePath: StorePath,
	references: readonly StorePathBasename[]
): readonly string[] {
	const path = storePath.value;
	const separator = path.lastIndexOf('/');
	const storeDirectory =
		separator === -1 ? undefined : path.slice(0, separator);

	const paths = references.map((reference) =>
		storeDirectory === undefined ? reference : `${storeDirectory}/${reference}`
	);

	return [...new Set(paths)].toSorted(byCodeUnit);
}

/**
The Nix narinfo fingerprint a signature is computed over. It commits to the
uncompressed NAR (`narHash`/`narSize`) and the references alone, never the
compressed encoding, so it can be signed before a blob's file hash and size
are known.
*/
export function narFingerprint(
	storePath: StorePath,
	narHash: string,
	narSize: number,
	references: readonly StorePathBasename[]
): NixFingerprint {
	return nixFingerprintSchema.parse(
		[
			'1',
			storePath.value,
			narHash,
			String(narSize),
			fingerprintReferenceStorePaths(storePath, references).join(',')
		].join(';')
	);
}
