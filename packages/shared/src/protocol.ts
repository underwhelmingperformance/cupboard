import { ProtocolError } from './errors.ts';
import { nixSha256HashPattern } from './scalars.ts';
import { storePathBasename, storePathHashOf } from './store-path.ts';

export class InvalidStorePathError extends ProtocolError {
	constructor(public readonly storePath: string) {
		super(`Invalid store path: ${storePath}`);
		this.name = 'InvalidStorePathError';
	}
}

export class InvalidStorePathBasenameError extends ProtocolError {
	constructor(public readonly basename: string) {
		super(`Invalid store path basename: ${basename}`);
		this.name = 'InvalidStorePathBasenameError';
	}
}

export class InvalidNixSha256HashError extends ProtocolError {
	constructor(public readonly value: string) {
		super(`Invalid Nix SHA-256 hash: ${value}`);
		this.name = 'InvalidNixSha256HashError';
	}
}

export class InvalidSha256DigestLengthError extends ProtocolError {
	constructor(public readonly length: number) {
		super(`Invalid SHA-256 digest length: ${String(length)}`);
		this.name = 'InvalidSha256DigestLengthError';
	}
}

const nixBase32Alphabet = '0123456789abcdfghijklmnpqrsvwxyz';
const base64Alphabet =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export class NixSha256Hash {
	private constructor(
		public readonly value: string,
		private readonly bytes: Uint8Array
	) {}

	static parse(value: string): NixSha256Hash {
		if (!nixSha256HashPattern.test(value)) {
			throw new InvalidNixSha256HashError(value);
		}

		return new NixSha256Hash(
			value,
			fromNixBase32(value.slice('sha256:'.length))
		);
	}

	static fromDigest(bytes: Uint8Array): NixSha256Hash {
		if (bytes.byteLength !== 32) {
			throw new InvalidSha256DigestLengthError(bytes.byteLength);
		}

		const digest = Uint8Array.from(bytes);

		return new NixSha256Hash(`sha256:${toNixBase32(digest)}`, digest);
	}

	digestBytes(): Uint8Array {
		return Uint8Array.from(this.bytes);
	}

	digestBase64(): string {
		return bytesToBase64(this.bytes);
	}

	toString(): string {
		return this.value;
	}
}

export class StorePath {
	constructor(public readonly value: string) {
		if (!value.startsWith('/nix/store/')) {
			throw new InvalidStorePathError(value);
		}
	}

	static basename(value: string): string {
		return new StorePath(value).basename;
	}

	static hash(value: string): string {
		return new StorePath(value).hash;
	}

	static referenceBasenames(references: readonly string[]): string[] {
		return references
			.map((reference) => StorePath.basename(reference))
			.toSorted();
	}

	get basename(): string {
		const basename = storePathBasename(this.value);

		if (basename === undefined) {
			throw new InvalidStorePathError(this.value);
		}

		return basename;
	}

	get hash(): string {
		const hash = storePathHashOf(this.value);

		if (hash === undefined) {
			throw new InvalidStorePathBasenameError(this.basename);
		}

		return hash;
	}
}

export class CacheInfo {
	static readonly default = new CacheInfo('/nix/store', true, 40);

	constructor(
		public readonly storeDirectory: string,
		public readonly wantMassQuery: boolean,
		public readonly priority: number
	) {}

	render(): string {
		return [
			`StoreDir: ${this.storeDirectory}`,
			`WantMassQuery: ${this.wantMassQuery ? '1' : '0'}`,
			`Priority: ${String(this.priority)}`,
			''
		].join('\n');
	}
}

export class NixConfig {
	constructor(
		public readonly url: string,
		public readonly publicKey: string
	) {}

	render(): string {
		return [
			`substituters = ${this.url}`,
			`trusted-public-keys = ${this.publicKey}`,
			''
		].join('\n');
	}
}

export function toNixSha256(bytes: Uint8Array): NixSha256Hash {
	return NixSha256Hash.fromDigest(bytes);
}

export function toNixBase32(bytes: Uint8Array): string {
	let encoded = '';
	const encodedLength = Math.ceil((bytes.byteLength * 8) / 5);

	for (let index = encodedLength - 1; index >= 0; index -= 1) {
		let digit = 0;

		for (let bit = 0; bit < 5; bit += 1) {
			const sourceBit = index * 5 + bit;

			if (sourceBit < bytes.byteLength * 8) {
				const sourceByte = bytes[Math.floor(sourceBit / 8)] ?? 0;
				digit |= ((sourceByte >> (sourceBit % 8)) & 1) << bit;
			}
		}

		encoded += nixBase32Alphabet[digit] ?? '';
	}

	return encoded;
}

const nixSha256Base32Length = 52;

export function fromNixBase32(value: string): Uint8Array {
	// A SHA-256 digest is exactly 52 Nix base32 characters; reject anything else
	// so a short input cannot decode to a zeroed digest nor a long one silently
	// drop its leading bits.
	if (value.length !== nixSha256Base32Length) {
		throw new InvalidNixSha256HashError(value);
	}

	const bytes = new Uint8Array(32);

	for (let position = 0; position < value.length; position += 1) {
		const digit = nixBase32Alphabet.indexOf(value.charAt(position));

		if (digit === -1) {
			throw new InvalidNixSha256HashError(value);
		}

		const index = value.length - 1 - position;

		for (let bit = 0; bit < 5; bit += 1) {
			const sourceBit = index * 5 + bit;

			if (sourceBit < bytes.byteLength * 8) {
				const byteIndex = Math.floor(sourceBit / 8);
				bytes[byteIndex] =
					(bytes[byteIndex] ?? 0) | (((digit >> bit) & 1) << (sourceBit % 8));
			}
		}
	}

	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	let result = '';

	for (let index = 0; index < bytes.byteLength; index += 3) {
		const first = bytes[index] ?? 0;
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

		result += base64Alphabet[(combined >> 18) & 0x3f] ?? '';
		result += base64Alphabet[(combined >> 12) & 0x3f] ?? '';
		result +=
			second === undefined
				? '='
				: (base64Alphabet[(combined >> 6) & 0x3f] ?? '');
		result +=
			third === undefined ? '=' : (base64Alphabet[combined & 0x3f] ?? '');
	}

	return result;
}
