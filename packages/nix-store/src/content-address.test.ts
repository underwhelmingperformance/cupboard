import { describe, expect, it } from 'vitest';

import {
	contentAddressAgreement,
	contentAddressedStorePath,
	isContentAddress
} from './content-address.ts';
import { bytesToBase64, bytesToHex } from './encoding.ts';
import { toNixBase32 } from './hash.ts';

const digest = Uint8Array.from({ length: 32 }, (_, index) => index * 5);
const base32 = toNixBase32(digest);

describe('isContentAddress', () => {
	it.each([
		{
			name: 'accepts a flat fixed-output address',
			value: `fixed:sha256:${base32}`
		},
		{
			name: 'accepts a NAR fixed-output address',
			value: `fixed:r:sha256:${base32}`
		},
		{ name: 'accepts a text address', value: `text:sha256:${base32}` },
		{
			name: 'accepts a base16 digest',
			value: `fixed:sha256:${bytesToHex(digest)}`
		},
		{
			name: 'accepts a base64 digest',
			value: `fixed:sha256:${bytesToBase64(digest)}`
		},
		{
			name: 'accepts an MD5 digest',
			value: `fixed:md5:${bytesToHex(digest.slice(0, 16))}`
		},
		{
			name: 'accepts the git method with a SHA-1 digest',
			value: `fixed:git:sha1:${bytesToHex(digest.slice(0, 20))}`
		},
		{
			name: 'accepts the git method with a SHA-256 digest',
			value: `fixed:git:sha256:${base32}`
		},
		{
			name: 'accepts the BLAKE3 algorithm in a flat address',
			value: `fixed:blake3:${bytesToHex(digest)}`
		},
		{
			name: 'accepts the BLAKE3 algorithm in a NAR address',
			value: `fixed:r:blake3:${base32}`
		},
		{
			name: 'accepts the BLAKE3 algorithm in a text address',
			value: `text:blake3:${bytesToBase64(digest)}`
		}
	])('$name', ({ value }) => {
		expect(isContentAddress(value)).toBe(true);
	});

	it.each([
		{
			name: 'rejects a value without a method separator',
			value: 'no separator here'
		},
		{ name: 'rejects an unknown method', value: `flat:sha256:${base32}` },
		{
			name: 'rejects a hash without a content-address method',
			value: `sha256:${base32}`
		},
		{
			name: 'rejects the git method after the NAR prefix',
			value: `fixed:r:git:sha1:${bytesToHex(digest.slice(0, 20))}`
		},
		{
			name: 'rejects the NAR prefix after the git method',
			value: `fixed:git:r:sha1:${bytesToHex(digest.slice(0, 20))}`
		},
		{
			name: 'rejects the git method in a text address',
			value: `text:git:sha1:${bytesToHex(digest.slice(0, 20))}`
		},
		{ name: 'rejects the git method without a hash', value: 'fixed:git:' },
		{
			name: 'rejects a BLAKE3 digest with the wrong length',
			value: `fixed:blake3:${bytesToHex(digest.slice(0, 20))}`
		},
		...[
			{ name: 'a space', character: ' ' },
			{ name: 'a tab', character: '\t' },
			{ name: 'a line feed', character: '\n' },
			{ name: 'a form feed', character: '\f' },
			{ name: 'a carriage return', character: '\r' }
		].flatMap(({ name, character }) => [
			{
				name: `rejects a base64 SHA-256 digest with ${name} in place of a digit`,
				value: `fixed:sha256:${'A'.repeat(20)}${character}${'A'.repeat(23)}`
			},
			{
				name: `rejects a base64 BLAKE3 digest with ${name} in place of a digit`,
				value: `fixed:blake3:${'A'.repeat(20)}${character}${'A'.repeat(23)}`
			}
		]),
		{ name: 'rejects a missing hash', value: 'fixed:' },
		{
			name: 'rejects a missing hash algorithm',
			value: `fixed:${base32}`
		},
		{
			name: 'rejects an unsupported hash algorithm',
			value: `fixed:md4:${'a'.repeat(32)}`
		},
		{
			name: 'rejects a digest with the wrong length',
			value: 'fixed:sha256:abcd'
		},
		{
			name: 'rejects a digest outside the Nix base32 alphabet',
			value: `fixed:sha256:${'e'.repeat(52)}`
		},
		{
			name: 'rejects SRI hash syntax',
			value: `fixed:sha256-${bytesToBase64(digest)}`
		},
		{ name: 'rejects fixed:r: without a hash', value: 'fixed:r:' },
		{ name: 'rejects an empty value', value: '' }
	])('$name', ({ value }) => {
		expect(isContentAddress(value)).toBe(false);
	});
});

// Store objects that Nix 2.35.3 created and described with
// `nix path-info --json`. The text object refers to two other text objects.
// `nix store make-content-addressed` rewrote `selfReferencing`, which refers
// to `dependency` and to itself.
const dependency = {
	storePath:
		'/nix/store/j3rv6jl91af9hjb40ybi25qyjnlk6iw2-cupboard-ca-vector-dep',
	ca: 'fixed:r:sha256:0i0g5h0y4w5xf5rynap2x27zaib43xl5qr5wlj9vw83ai7p732m1',
	narHash: 'sha256:0i0g5h0y4w5xf5rynap2x27zaib43xl5qr5wlj9vw83ai7p732m1'
};
const selfReferencing = {
	storePath: '/nix/store/r631vhqqqlilnnq11rr9ix0qq0355y5m-cupboard-ca-vector',
	ca: 'fixed:r:sha256:033ylxayv2kqls2kvwfnl3sk5bldvazvghh250an97z8hy19jygl',
	narHash: 'sha256:1w0hvygs6sgk7jp7anw715dfs1nhai9s1l0lv6cz9sn8nzxs9bfz',
	references: [
		'j3rv6jl91af9hjb40ybi25qyjnlk6iw2-cupboard-ca-vector-dep',
		'r631vhqqqlilnnq11rr9ix0qq0355y5m-cupboard-ca-vector'
	]
};
const narSha256 = {
	storePath: '/nix/store/yzrld0084awgm77sny9kr22i020fbinz-vec',
	ca: 'fixed:r:sha256:0sldaa6dd6dsfm1c7f8z9i32dfhn53aw1kyrlid1naa7hb6biy4v',
	narHash: 'sha256:0sldaa6dd6dsfm1c7f8z9i32dfhn53aw1kyrlid1naa7hb6biy4v'
};
const flatSha256 = {
	storePath: '/nix/store/4nlmsc109zb7iwf5xilrdpzm38gr1z5z-vec',
	ca: 'fixed:sha256:1xk2hhjr0f2n4adj1h688wlz59xpl86y1r8bd2pjasg8gy16mikb'
};
const text = {
	storePath: '/nix/store/v7ydj3ccbbxh0rl0c4m8lci1v5g61029-vec',
	ca: 'text:sha256:179gmwg1wf2hzi51n6bsj166ik1q8v51krashfqcq7yzaxzxv657',
	references: [
		'kmmkrxlfw7rbwdnaj9js21xg9m42q8kw-a',
		'pxvcv8a2q21xkd9l7zrzb2xlqzah47md-b'
	]
};

describe('contentAddressedStorePath', () => {
	it.each([
		{
			name: 'a NAR SHA-256 address',
			ca: narSha256.ca,
			references: [],
			hasSelfReference: false,
			expected: narSha256.storePath
		},
		{
			name: 'a NAR SHA-256 address with references and a self-reference',
			ca: selfReferencing.ca,
			references: ['j3rv6jl91af9hjb40ybi25qyjnlk6iw2-cupboard-ca-vector-dep'],
			hasSelfReference: true,
			expected: selfReferencing.storePath
		},
		{
			name: 'a NAR SHA-1 address',
			ca: 'fixed:r:sha1:xkhcd8dhk6h23ys3piz8irxjgz43vh2g',
			references: [],
			hasSelfReference: false,
			expected: '/nix/store/b6li9i0bbrk516n15pqrgjkxv69w5a8i-vec'
		},
		{
			name: 'a NAR BLAKE3 address',
			ca: 'fixed:r:blake3:0556018ypy2h449yimr95diymfxa60kzlkr3w3j7p2qkjxw6ymla',
			references: [],
			hasSelfReference: false,
			expected: '/nix/store/wx5bkl6j28d181zi96gjxrm0wrhs1mqn-vec'
		},
		{
			name: 'a flat SHA-256 address',
			ca: flatSha256.ca,
			references: [],
			hasSelfReference: false,
			expected: flatSha256.storePath
		},
		{
			name: 'a flat MD5 address',
			ca: 'fixed:md5:5k3537sv5p3dmsj6l9n59sm9f9',
			references: [],
			hasSelfReference: false,
			expected: '/nix/store/190zmf984bwk7s1vdlik69qavxam0482-vec'
		},
		{
			name: 'a git SHA-1 address',
			ca: 'fixed:git:sha1:dpmsyvy3sln3sijvxrh32933kwcqcnpv',
			references: [],
			hasSelfReference: false,
			expected: '/nix/store/5gcvylq3h92xyra9sxjnvy9l77zckxyd-vec'
		},
		{
			name: 'a git SHA-256 address',
			ca: 'fixed:git:sha256:0dsvz9v8qnnlrb2lvsdp9afyqwkkiq8ffn6g7i3qyka3fb4qhpxv',
			references: [],
			hasSelfReference: false,
			expected: '/nix/store/x59x4s0v64knwwddgm9r7nda249q7lcc-vec'
		},
		{
			name: 'a text address with references in reverse order',
			ca: text.ca,
			references: text.references.toReversed(),
			hasSelfReference: false,
			expected: text.storePath
		},
		{
			name: 'a text address with a self-reference, which Nix refuses',
			ca: text.ca,
			references: text.references,
			hasSelfReference: true,
			expected: undefined
		},
		{
			name: 'a text address with a SHA-1 hash, which Nix refuses',
			ca: `text:sha1:${bytesToHex(digest.slice(0, 20))}`,
			references: [],
			hasSelfReference: false,
			expected: undefined
		},
		{
			name: 'a flat address with references, which Nix refuses',
			ca: flatSha256.ca,
			references: text.references,
			hasSelfReference: false,
			expected: undefined
		},
		{
			name: 'a git address with an MD5 hash, which Nix refuses',
			ca: `fixed:git:md5:${bytesToHex(digest.slice(0, 16))}`,
			references: [],
			hasSelfReference: false,
			expected: undefined
		},
		{
			name: 'a value that is not a content address',
			ca: `sha256:${base32}`,
			references: [],
			hasSelfReference: false,
			expected: undefined
		}
	])(
		'computes the store path of $name',
		({ ca, references, hasSelfReference, expected }) => {
			expect(
				contentAddressedStorePath({
					storeDirectory: '/nix/store',
					name: expected?.split('-').slice(1).join('-') ?? 'vec',
					contentAddress: ca,
					references,
					hasSelfReference
				})
			).toBe(expected);
		}
	);
});

describe('contentAddressAgreement', () => {
	it.each([
		{
			name: 'a NAR SHA-256 address whose hash is the NAR hash',
			info: { ...dependency, references: [] },
			expected: 'agrees'
		},
		{
			// Nix hashes a self-referencing object with its own hash masked, so the
			// content address differs from the NAR hash.
			name: 'a self-referencing NAR address with a different NAR hash',
			info: selfReferencing,
			expected: 'agrees'
		},
		{
			name: 'a flat address, whose hash is not a NAR hash',
			info: { ...flatSha256, narHash: dependency.narHash, references: [] },
			expected: 'agrees'
		},
		{
			name: 'a text address with its references',
			info: { ...text, narHash: dependency.narHash },
			expected: 'agrees'
		},
		{
			name: 'an address for another store path',
			info: { ...narSha256, storePath: flatSha256.storePath, references: [] },
			expected: 'store-path-differs'
		},
		{
			name: 'an address without the references that produced the path',
			info: { ...text, narHash: dependency.narHash, references: [] },
			expected: 'store-path-differs'
		},
		{
			name: 'a NAR SHA-256 address with a different NAR hash',
			info: { ...narSha256, narHash: dependency.narHash, references: [] },
			expected: 'nar-hash-differs'
		}
	])('reports that $name $expected', ({ info, expected }) => {
		expect(contentAddressAgreement(info)).toBe(expected);
	});
});
