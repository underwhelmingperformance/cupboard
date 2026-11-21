import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { bytesToHex } from './encoding.ts';
import {
	type ContentAddressHash,
	decodeContentAddressHash,
	decodeNixHash,
	toNixBase32
} from './hash.ts';
import {
	byCodeUnit,
	storeDirectoryOf,
	storePathBasename
} from './store-path.ts';

type ContentAddressMethod = 'text' | 'flat' | 'nar' | 'git';

interface ParsedContentAddress {
	readonly method: ContentAddressMethod;
	readonly hash: ContentAddressHash;
}

// `r:` and `git:` are the method prefixes that can follow `fixed:`. Nix reads
// `git:` only when its `git-hashing` experimental feature is enabled.
const methodPrefixes = [
	{ prefix: 'r:', method: 'nar' },
	{ prefix: 'git:', method: 'git' }
] as const;

function parseContentAddress(value: string): ParsedContentAddress | undefined {
	const separator = value.indexOf(':');

	if (separator === -1) {
		return undefined;
	}

	const kind = value.slice(0, separator);
	const rest = value.slice(separator + 1);

	if (kind === 'text') {
		return withHash('text', rest);
	}

	if (kind !== 'fixed') {
		return undefined;
	}

	const prefixed = methodPrefixes.find(({ prefix }) => rest.startsWith(prefix));

	if (prefixed === undefined) {
		return withHash('flat', rest);
	}

	return withHash(prefixed.method, rest.slice(prefixed.prefix.length));
}

function withHash(
	method: ContentAddressMethod,
	value: string
): ParsedContentAddress | undefined {
	const hash = decodeContentAddressHash(value);

	return hash === undefined ? undefined : { method, hash };
}

/**
Returns whether the value is a content address that Nix reads:
`text:<hash>`, `fixed:<hash>`, `fixed:r:<hash>` or `fixed:git:<hash>`, where
`<hash>` is `<algorithm>:<digest>`.

Nix reads the `git` method and the `blake3` algorithm only when the
`git-hashing` and `blake3-hashes` experimental features are enabled. The
narinfo of a path records a content address that another Nix produced, with
features that cupboard cannot see, so this accepts the values that Nix
accepts with every feature enabled.
*/
export function isContentAddress(value: string): boolean {
	return parseContentAddress(value) !== undefined;
}

/**
The parts of a store object that decide its content-addressed store path.
`references` lists the basenames of the other store paths that the object
refers to.
*/
export interface ContentAddressedObject {
	readonly storeDirectory: string;
	readonly name: string;
	readonly contentAddress: string;
	readonly references: readonly string[];
	readonly hasSelfReference: boolean;
}

/**
Computes the store path that Nix derives from a content address, as
`StoreDirConfig::makeFixedOutputPathFromCA` does. Returns `undefined` for a
value that is not a content address, and for a combination that Nix refuses
to compute a path for: a text address with a hash other than SHA-256 or with
a self-reference, a git address with a hash other than SHA-1 or SHA-256, and
references on any fixed address except a NAR SHA-256 one.
*/
export function contentAddressedStorePath(
	object: ContentAddressedObject
): string | undefined {
	const parsed = parseContentAddress(object.contentAddress);

	if (parsed === undefined) {
		return undefined;
	}

	const { method, hash } = parsed;
	const references = [...new Set(object.references)]
		.toSorted(byCodeUnit)
		.map((basename) => `:${object.storeDirectory}/${basename}`)
		.join('');

	if (method === 'text') {
		if (hash.algorithm !== 'sha256' || object.hasSelfReference) {
			return undefined;
		}

		return storePath(object, `text${references}`, hash);
	}

	if (method === 'nar' && hash.algorithm === 'sha256') {
		const self = object.hasSelfReference ? ':self' : '';

		return storePath(object, `source${references}${self}`, hash);
	}

	if (references !== '' || object.hasSelfReference) {
		return undefined;
	}

	if (
		method === 'git' &&
		hash.algorithm !== 'sha1' &&
		hash.algorithm !== 'sha256'
	) {
		return undefined;
	}

	const prefix = { flat: '', nar: 'r:', git: 'git:' }[method];
	const payload = `fixed:out:${prefix}${printHash(hash)}:`;

	return storePath(object, 'output:out', {
		algorithm: 'sha256',
		bytes: sha256OfText(payload)
	});
}

/**
How a narinfo's content address relates to the rest of the narinfo:

- `agrees`: the content address, the references and the store directory
  produce the store path, and the NAR hash does not contradict the address.
- `store-path-differs`: they produce another store path, or none.
- `nar-hash-differs`: the address is a NAR SHA-256 address of an object
  without a self-reference, so its hash is the NAR hash, and the NAR hash is
  different.

Nix hashes a self-referencing object with its own hash replaced, and a flat,
text or git address hashes something other than the NAR. The NAR hash of
such an object cannot be checked against its address without reading the
NAR.
*/
export type ContentAddressAgreement =
	'agrees' | 'store-path-differs' | 'nar-hash-differs';

/**
The narinfo fields that `contentAddressAgreement` compares. `references`
lists basenames, and includes the object's own basename when it refers to
itself.
*/
export interface ContentAddressedPathInfo {
	readonly storePath: string;
	readonly references: readonly string[];
	readonly narHash: string;
	readonly ca: string;
}

/**
Compares a narinfo's content address with its store path and NAR hash. Nix
accepts a narinfo without a trusted signature when its content address
produces its store path, and then checks the NAR against the address.
*/
export function contentAddressAgreement(
	info: ContentAddressedPathInfo
): ContentAddressAgreement {
	const storeDirectory = storeDirectoryOf(info.storePath);
	const basename = storePathBasename(info.storePath);

	if (storeDirectory === undefined || basename === undefined) {
		return 'store-path-differs';
	}

	const hasSelfReference = info.references.includes(basename);
	const expected = contentAddressedStorePath({
		storeDirectory,
		name: basename.slice(basename.indexOf('-') + 1),
		contentAddress: info.ca,
		references: info.references.filter((reference) => reference !== basename),
		hasSelfReference
	});

	if (expected !== info.storePath) {
		return 'store-path-differs';
	}

	const parsed = parseContentAddress(info.ca);

	if (
		hasSelfReference ||
		parsed?.method !== 'nar' ||
		parsed.hash.algorithm !== 'sha256'
	) {
		return 'agrees';
	}

	const narHash = decodeNixHash(info.narHash);

	return narHash !== undefined &&
		bytesToHex(narHash.bytes) === bytesToHex(parsed.hash.bytes)
		? 'agrees'
		: 'nar-hash-differs';
}

function printHash(hash: ContentAddressHash): string {
	return `${hash.algorithm}:${bytesToHex(hash.bytes)}`;
}

// Zod refinements are synchronous, and Web Crypto has only an asynchronous
// digest, so the upload schemas need a synchronous SHA-256.
function sha256OfText(value: string): Uint8Array {
	return sha256(utf8ToBytes(value));
}

// `StoreDirConfig::makeStorePath`: the path hash is the SHA-256 digest of the
// description, folded to 20 bytes by XOR.
function storePath(
	object: ContentAddressedObject,
	type: string,
	hash: ContentAddressHash
): string {
	const description = `${type}:${printHash(hash)}:${object.storeDirectory}:${object.name}`;
	const digest = sha256OfText(description);
	const folded = new Uint8Array(20);

	for (const [index, byte] of digest.entries()) {
		const position = index % folded.length;
		folded[position] = (folded[position] ?? 0) ^ byte;
	}

	return `${object.storeDirectory}/${toNixBase32(folded)}-${object.name}`;
}
