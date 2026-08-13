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

// The literal a cache serves for a path whose deriver it does not know.
// cache.nixos.org carries it on many older paths, and Nix reads it as an
// absent deriver.
const unknownDeriver = 'unknown-deriver';

/** What one narinfo document offers for the store path it describes. */
export interface NarInfoOffer {
	readonly source: 'substituter';
	readonly references: readonly StorePathString[];
	readonly deriver?: string;
	readonly narHash: NixSha256Hash;
	readonly signatures: readonly string[];
	readonly downloadSize: number;
	readonly narSize: number;
}

// A served narinfo names the deriver and every reference by basename, while a
// substitutable-path answer names them the way the store does. A narinfo is
// read whatever compression it names, and a document missing what Nix
// requires of one is refused as corrupt, the way Nix refuses it.
export function offerFromNarInfo(
	source: string,
	storePath: StorePathString,
	storeDirectory: StoreDirectory
): NarInfoOffer {
	const read = new NarInfoReader(source, storePath, storeDirectory);

	return read.offer();
}

/**
 * Reads a narinfo the way Nix reads one from a substituter. Nix accepts a
 * document only when every field it carries is one Nix can read, so each is
 * decoded here rather than matched: a value let through that Nix would refuse
 * the whole document over is a path counted as available that Nix would then
 * decline to fetch.
 *
 * A field's value starts two characters past its colon, and every line ends
 * with a newline, both of which Nix requires exactly.
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

	// A narinfo carries one `Sig` line per key that signed the path.
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
			// The answer stands for the path it was asked about. A substituter
			// naming another describes something the caller did not ask for.
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

		this.readMeasuredField(name, value);
	}

	private readMeasuredField(name: string, value: string): void {
		if (name === 'Compression') {
			// An empty value is the one Nix reads as its own default.
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

		this.readNamedField(name, value);
	}

	private readNamedField(name: string, value: string): void {
		if (name === 'References') {
			// Nix separates them with single spaces, so anything else lands
			// inside a name and stops it being one.
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
			// The literal a cache serves for a path whose deriver it does not
			// know, which Nix reads as no deriver.
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

	// A path is addressed one way, so a document stating a second address
	// states two answers to the same question. An empty value states none at
	// all, leaving the address the document has yet to state.
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

	// Nix reads a hash field as an algorithm and a digest, in any of the
	// spellings it writes them in, and refuses the document when it cannot.
	// A NAR hash is kept when it is sha256, the algorithm a store path's own
	// hash uses and so the only one an offer can be compared under; a document
	// naming any other algorithm states a hash this reader has no offer to
	// make from.
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

		// Nix reads a document missing any of these as one the substituter did
		// not finish writing.
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

// The compression a narinfo may name, which Nix reads by the same list.
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
