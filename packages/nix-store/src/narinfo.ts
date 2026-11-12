import { z } from 'zod';

import { isContentAddress } from './content-address.ts';
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
	storePathBasenameSchema,
	storePathSchema
} from './scalars.ts';
import { canonicalNixSignature } from './signature.ts';
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

// Nix reads a narinfo as records. A field name ends at the next colon, even on
// a later line. A value starts two bytes after the colon, whatever they are,
// and ends at the next line feed. Nothing is trimmed, and a record must end in
// a line feed. Nix ignores a field with an unknown name. This lexer returns
// every field, and the schema reads only the ones that it knows. It refuses the
// records that a line-based reader would read differently from Nix: a name that
// contains a line feed, which hides the fields on the lines that it spans, and a
// colon that is not followed by a space, because Nix drops the character after
// the colon.
export function parseFields(source: string): Record<string, string[]> {
	const fields = new Map<string, string[]>();
	let position = 0;

	while (position < source.length) {
		const colon = source.indexOf(':', position);
		const name = colon === -1 ? '' : source.slice(position, colon);
		const end = source.indexOf('\n', colon + 2);

		if (
			colon === -1 ||
			end === -1 ||
			name.includes('\n') ||
			source[colon + 1] !== ' '
		) {
			const lineEnd = source.indexOf('\n', position);

			throw new MalformedNarInfoLineError(
				source.slice(position, lineEnd === -1 ? undefined : lineEnd)
			);
		}

		const values = fields.get(name) ?? [];

		values.push(source.slice(colon + 2, end));
		fields.set(name, values);
		position = end + 1;
	}

	return Object.fromEntries(fields);
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

/**
The references in a narinfo `References` value, as Nix reads them. Nix separates
references with spaces only, ignores empty tokens and keeps the rest in a set,
so a repeated reference counts once and the references come in the set's order.
*/
export function narInfoReferences(value: string): string[] {
	return [
		...new Set(value.split(' ').filter((entry) => entry !== ''))
	].toSorted(byCodeUnit);
}

const references = z
	.tuple([z.string()])
	.transform(([value]) => narInfoReferences(value))
	.pipe(boundedReferencesSchema);

const lineScalar = z.string().refine((value) => !hasControlCharacter(value));

const url = lineScalar.min(1);

/**
The `Deriver` value that Nix reads as no deriver.
*/
export const unknownDeriver = 'unknown-deriver';

const deriver = z
	.tuple([z.string()])
	.transform(([value]) => (value === unknownDeriver ? undefined : value))
	.pipe(storePathBasenameSchema.optional())
	.optional();

// Nix reads an empty `CA` value as no content address.
const contentAddress = z
	.tuple([z.string()])
	.transform(([value]) => (value === '' ? undefined : value))
	.pipe(z.string().refine(isContentAddress).optional())
	.optional();

const signature = z.string().transform((value, ctx) => {
	const canonical = canonicalNixSignature(value);

	if (canonical === undefined) {
		ctx.addIssue({ code: 'custom', message: 'not a narinfo signature' });

		return z.NEVER;
	}

	return canonical;
});

const optionalText = z
	.tuple([lineScalar])
	.transform(([value]) => (value === '' ? undefined : value))
	.optional();

const narInfoFieldsSchema = z.object({
	storePath: storePathSchema,
	url,
	compression: compressionSchema,
	fileHash: nixSha256HashSchema,
	fileSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	narHash: nixSha256HashSchema,
	narSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	references: boundedReferencesSchema,
	deriver: lineScalar.optional(),
	ca: lineScalar.optional(),
	sigs: z.array(lineScalar)
});

const requiredRecords = {
	StorePath: single(storePathSchema),
	URL: single(url),
	Compression: single(compressionSchema),
	FileHash: single(nixSha256HashSchema),
	FileSize: narInfoInteger,
	NarHash: single(nixSha256HashSchema),
	NarSize: narInfoInteger.pipe(z.number().positive())
};

interface NarInfoRecords {
	readonly StorePath: string;
	readonly URL: string;
	readonly Compression: 'zstd';
	readonly FileHash: string;
	readonly FileSize: number;
	readonly NarHash: string;
	readonly NarSize: number;
	readonly References: readonly string[];
	readonly Deriver?: string | undefined;
	readonly CA?: string | undefined;
	readonly Sig: readonly string[];
}

function toNarInfoFields(fields: NarInfoRecords): NarInfoFields {
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

export const narInfoSchema = z
	.object({
		...requiredRecords,
		References: references,
		Deriver: deriver,
		CA: contentAddress,
		Sig: z
			.array(signature)
			.default([])
			// Nix keeps the signatures in a set. `signature` returns the canonical
			// form, which is the same for the same key name and decoded signature.
			.transform((signatures) => [...new Set(signatures)])
	})
	.transform(toNarInfoFields);

// The optional records as `NarInfo.render` accepts them. A stored row can have
// been written under rules that were less strict than the ones for input.
const storedNarInfoSchema = z
	.object({
		...requiredRecords,
		References: z
			.tuple([z.string()])
			.transform(([value]) => value.split(' ').filter((entry) => entry !== ''))
			.pipe(boundedReferencesSchema),
		Deriver: optionalText,
		CA: optionalText,
		Sig: z.array(lineScalar).default([])
	})
	.transform(toNarInfoFields);

export function parseNarInfo(source: string): NarInfo {
	return NarInfo.fromFields(narInfoSchema.parse(parseFields(source)));
}

/**
Parses a narinfo that this server rendered from a stored row. A row can be older
than the rules that apply to new input, and can repeat a reference or have a
`CA`, `Deriver` or `Sig` that Nix rejects. This reads such a narinfo as
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
