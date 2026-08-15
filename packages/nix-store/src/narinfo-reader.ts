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

// Some caches write this value for a path whose deriver they do not know.
// cache.nixos.org serves it for many older paths, and Nix reads it as no
// deriver.
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

// A narinfo identifies the deriver and references by basename, while a
// substitutable-path response uses full store paths. Accept every compression
// supported by Nix and reject documents that omit fields required by Nix.
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

	// The fields describing the archive itself: how it is compressed, what it
	// hashes to and how large it is.
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

	// The path's references, deriver, signatures and content address.
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

	// A narinfo may specify at most one non-empty content address.
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
	// hash uses and therefore the only algorithm available for comparing offers.
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

		// Nix rejects a narinfo missing any of these fields as corrupt, so this
		// reader does too and the path is never reported as available.
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

// Compression algorithms accepted by Nix for narinfos.
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
