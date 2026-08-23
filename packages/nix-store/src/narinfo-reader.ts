import { isContentAddress } from './content-address.ts';
import { CorruptNarInfoError, MismatchedNarInfoPathError } from './errors.ts';
import { decodeNixHashField, NixSha256Hash } from './hash.ts';
import { narInfoSize } from './narinfo.ts';
import {
	referencesSchema,
	type StoreDirectory,
	storePathSchema,
	type StorePathString
} from './scalars.ts';
import { isNixSignature } from './signature.ts';

// Some caches use this value when the deriver is unknown. cache.nixos.org
// serves it for many older paths, and Nix parses it as an absent deriver.
const unknownDeriver = 'unknown-deriver';

export interface NarInfoOffer {
	readonly source: 'substituter';
	readonly references: readonly StorePathString[];
	readonly deriver?: string;
	readonly narHash: NixSha256Hash;
	readonly signatures: readonly string[];
	readonly downloadSize: number;
	readonly narSize: number;
}

/**
 * Parses substitution evidence from a narinfo. Deriver and reference basenames
 * are resolved in `storeDirectory`. The parser validates every recognised
 * field against Nix's grammar, including compression values and required
 * fields, and requires `StorePath` to match the requested path.
 */
export function offerFromNarInfo(
	source: string,
	storePath: StorePathString,
	storeDirectory: StoreDirectory
): NarInfoOffer {
	const read = new NarInfoReader(source, storePath, storeDirectory);

	return read.offer();
}

/**
 * Parses a narinfo using Nix's substituter rules. Every recognised field is
 * decoded so this client does not report a path as available when Nix would
 * reject its narinfo.
 *
 * A field's value starts two characters after its colon, and every line ends
 * with a newline. Nix requires both.
 */
class NarInfoReader {
	private references?: readonly StorePathString[];

	private deriver?: StorePathString;

	private url = '';

	private narSize = 0;

	private downloadSize = 0;

	private hasPath = false;

	private narHash?: NixSha256Hash;

	private contentAddress?: string;

	private readonly signatures: string[] = [];

	constructor(
		private readonly source: string,
		private readonly storePath: StorePathString,
		private readonly storeDirectory: StoreDirectory
	) {}

	private readLines(): void {
		let position = 0;

		while (position < this.source.length) {
			const colon = this.source.indexOf(':', position);

			if (colon === -1) {
				throw new CorruptNarInfoError(this.storePath);
			}

			const end = this.source.indexOf('\n', colon + 2);

			if (end === -1) {
				throw new CorruptNarInfoError(this.storePath);
			}

			this.readField(
				this.source.slice(position, colon),
				this.source.slice(colon + 2, end)
			);
			position = end + 1;
		}
	}

	private readField(name: string, value: string): void {
		if (name === 'StorePath') {
			if (value !== this.storePath) {
				throw new MismatchedNarInfoPathError(this.storePath);
			}

			this.hasPath = true;

			return;
		}

		if (name === 'URL') {
			this.url = value;

			return;
		}

		this.readArchiveField(name, value);
	}

	private readArchiveField(name: string, value: string): void {
		if (name === 'Compression') {
			// Nix interprets an empty value as its default compression.
			if (value !== '' && !compressionAlgorithms.has(value)) {
				throw new CorruptNarInfoError(this.storePath);
			}

			return;
		}

		if (name === 'FileHash' || name === 'NarHash') {
			this.readHash(name, value);

			return;
		}

		if (name === 'FileSize' || name === 'NarSize') {
			this.readSize(name, value);

			return;
		}

		this.readReferenceField(name, value);
	}

	private readReferenceField(name: string, value: string): void {
		if (name === 'References') {
			// Nix separates references with single spaces. Other whitespace becomes
			// part of a basename, which makes the store path invalid.
			if (this.references !== undefined) {
				throw new CorruptNarInfoError(this.storePath);
			}

			const references = referencesSchema.safeParse(
				value.split(' ').filter(Boolean)
			);

			if (!references.success) {
				throw new CorruptNarInfoError(this.storePath);
			}

			this.references = references.data.map((basename) =>
				this.inStore(basename)
			);

			return;
		}

		if (name === 'Deriver') {
			this.deriver = value === unknownDeriver ? undefined : this.inStore(value);

			return;
		}

		if (name === 'Sig') {
			if (!isNixSignature(value)) {
				throw new CorruptNarInfoError(this.storePath);
			}

			this.signatures.push(value);

			return;
		}

		if (name === 'CA') {
			this.readContentAddress(value);
		}
	}

	private readContentAddress(value: string): void {
		if (this.contentAddress !== undefined) {
			throw new CorruptNarInfoError(this.storePath);
		}

		if (value === '') {
			return;
		}

		if (!isContentAddress(value)) {
			throw new CorruptNarInfoError(this.storePath);
		}

		this.contentAddress = value;
	}

	// Validate every hash field so a malformed FileHash still rejects the
	// document. Retain only a sha256 NarHash because offers compare NAR contents
	// with that algorithm.
	private readHash(name: string, value: string): void {
		const hash = decodeNixHashField(value);

		if (hash === undefined) {
			throw new CorruptNarInfoError(this.storePath);
		}

		if (name !== 'NarHash' || hash.algorithm !== 'sha256') {
			return;
		}

		this.narHash = NixSha256Hash.fromDigest(hash.bytes);
	}

	private readSize(name: string, value: string): void {
		const size = narInfoSize(value);

		if (size === undefined) {
			throw new CorruptNarInfoError(this.storePath);
		}

		if (name === 'NarSize') {
			this.narSize = size;
		} else {
			this.downloadSize = size;
		}
	}

	private inStore(basename: string): StorePathString {
		const named = storePathSchema.safeParse(
			`${this.storeDirectory}/${basename}`
		);

		if (!named.success) {
			throw new CorruptNarInfoError(this.storePath);
		}

		return named.data;
	}

	offer(): NarInfoOffer {
		this.readLines();

		const narHash = this.narHash;

		// If any of these fields are missing, Nix treats the narinfo as corrupt.
		// Reject the narinfo here so the client never reports the path as available.
		if (
			narHash === undefined ||
			!this.hasPath ||
			this.url === '' ||
			this.narSize === 0
		) {
			throw new CorruptNarInfoError(this.storePath);
		}

		return {
			source: 'substituter',
			references: this.references ?? [],
			...(this.deriver !== undefined && { deriver: this.deriver }),
			narHash,
			signatures: [...this.signatures],
			downloadSize: this.downloadSize,
			narSize: this.narSize
		};
	}
}

const compressionAlgorithms = new Set([
	'none',
	'br',
	'bzip2',
	'compress',
	'grzip',
	'gzip',
	'lrzip',
	'lz4',
	'lzip',
	'lzma',
	'lzop',
	'xz',
	'zstd'
]);
