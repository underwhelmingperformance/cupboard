import {
	hasControlCharacter,
	nixSha256HashPattern,
	rootNameMaxLength,
	rootTtlMaxSeconds,
	rootTtlMinSeconds,
	storePathHashPattern
} from './scalars.ts';
import { storePathBasename, storePathHashOf } from './store-path.ts';

export interface CacheInfoFields {
	readonly storeDirectory: string;
	readonly wantMassQuery: boolean;
	readonly priority: number;
}

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
	readonly sig?: string;
}

export interface UploadPathNegotiationFields {
	readonly storePathHash: string;
	readonly storePath: string;
	readonly narHash: string;
	readonly narSize: number;
	readonly references: readonly string[];
	readonly deriver?: string;
	readonly ca?: string;
}

export interface UploadBlobMetadataFields {
	readonly fileHash: string;
	readonly fileSize: number;
	readonly compression: 'zstd';
}

export interface UploadPathMetadataFields
	extends UploadPathNegotiationFields, UploadBlobMetadataFields {}

export interface UploadNegotiateRequest {
	readonly paths: readonly UploadPathNegotiationFields[];
}

export type UploadPrepareRequest = UploadBlobMetadataFields;

export interface UploadPrepareResponse {
	readonly uploadUrl: string;
	readonly uploadHeaders: Readonly<Record<string, string>>;
	readonly expiresAt: string;
}

export interface UploadNegotiateResponse {
	readonly uploads: readonly UploadDecision[];
}

export type UploadDecision =
	| {
			readonly action: 'skip';
			readonly storePathHash: string;
			readonly narHash: string;
	  }
	| {
			readonly action: 'commit';
			readonly storePathHash: string;
			readonly narHash: string;
			readonly uploadId: string;
	  }
	| {
			readonly action: 'upload';
			readonly storePathHash: string;
			readonly narHash: string;
			readonly uploadId: string;
			readonly r2Key: string;
			readonly expiresAt: string;
	  };

export interface CommitResponse {
	readonly storePathHash: string;
	readonly narHash: string;
	readonly status: 'committed' | 'already-present';
}

export interface BootstrapResponse {
	readonly url: string;
	readonly publicKey: string;
	readonly token: string;
}

export interface StatsResponse {
	readonly storePaths: number;
	readonly narBlobs: number;
	readonly pendingUploads: number;
	readonly totalFileSize: number;
}

export interface DeletePathRequestFields {
	readonly storePathHash: string;
}

export interface DeletePathResponse {
	readonly storePathHash: string;
	readonly deleted: boolean;
	readonly narScheduledForDeletion: boolean;
}

export interface RootSetRequestFields {
	readonly name: string;
	readonly targets: readonly string[];
	readonly ttlSeconds?: number;
}

export interface RootSetBody {
	readonly targets: readonly string[];
	readonly ttlSeconds?: number;
}

export interface RootTarget {
	readonly storePathHash: string;
	readonly storePath: string;
	readonly present: boolean;
}

export interface RootSummary {
	readonly name: string;
	readonly expiresAt?: string;
	readonly expired: boolean;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly targets: readonly RootTarget[];
}

export type RootSetResponse = RootSummary;

export interface RootListResponse {
	readonly roots: readonly RootSummary[];
}

export interface RootRemoveRequestFields {
	readonly name: string;
}

export interface RootRemoveResponse {
	readonly name: string;
	readonly removed: boolean;
}

export abstract class ProtocolError extends Error {}

export class InvalidNarInfoLineError extends ProtocolError {
	constructor(public readonly line: string) {
		super(`Invalid narinfo line: ${line}`);
		this.name = 'InvalidNarInfoLineError';
	}
}

export class UnsupportedNarInfoCompressionError extends ProtocolError {
	constructor(public readonly compression: string) {
		super(`Unsupported narinfo compression: ${compression}`);
		this.name = 'UnsupportedNarInfoCompressionError';
	}
}

export class UnsupportedUploadBlobCompressionError extends ProtocolError {
	constructor(public readonly compression: unknown) {
		super(`Unsupported upload blob compression: ${String(compression)}`);
		this.name = 'UnsupportedUploadBlobCompressionError';
	}
}

export class MissingNarInfoFieldError extends ProtocolError {
	constructor(public readonly field: string) {
		super(`Missing narinfo field: ${field}`);
		this.name = 'MissingNarInfoFieldError';
	}
}

type NarInfoIntegerField = 'FileSize' | 'NarSize';

export class InvalidNarInfoIntegerFieldError extends ProtocolError {
	constructor(public readonly field: NarInfoIntegerField) {
		super(`Invalid integer narinfo field: ${field}`);
		this.name = 'InvalidNarInfoIntegerFieldError';
	}
}

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

export class InvalidStorePathHashError extends ProtocolError {
	constructor(public readonly storePathHash: string) {
		super(`Invalid store path hash: ${storePathHash}`);
		this.name = 'InvalidStorePathHashError';
	}
}

export class InvalidRootNameError extends ProtocolError {
	constructor(public readonly rootName: string) {
		super(`Invalid root name: ${rootName}`);
		this.name = 'InvalidRootNameError';
	}
}

export class InvalidRootTargetsError extends ProtocolError {
	constructor() {
		super('A retention root requires at least one target');
		this.name = 'InvalidRootTargetsError';
	}
}

export class InvalidRootTtlError extends ProtocolError {
	constructor(public readonly ttlSeconds: number) {
		super(`Invalid root TTL in seconds: ${String(ttlSeconds)}`);
		this.name = 'InvalidRootTtlError';
	}
}

export class StorePathHashMismatchError extends ProtocolError {
	constructor(
		public readonly storePath: string,
		public readonly expectedStorePathHash: string,
		public readonly actualStorePathHash: string
	) {
		super(
			`Store path hash ${expectedStorePathHash} does not match ${actualStorePathHash} from ${storePath}`
		);
		this.name = 'StorePathHashMismatchError';
	}
}

export class InvalidStorePathReferenceError extends ProtocolError {
	constructor(public readonly reference: string) {
		super(`Invalid store path reference: ${reference}`);
		this.name = 'InvalidStorePathReferenceError';
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

export abstract class InvalidUploadPathMetadataHashError extends ProtocolError {
	constructor(
		message: string,
		public override readonly cause: InvalidNixSha256HashError
	) {
		super(message);
		this.name = 'InvalidUploadPathMetadataHashError';
	}
}

export class InvalidUploadPathMetadataNarHashError extends InvalidUploadPathMetadataHashError {
	constructor(cause: InvalidNixSha256HashError) {
		super('NAR hash must be a sha256 Nix base32 hash', cause);
		this.name = 'InvalidUploadPathMetadataNarHashError';
	}
}

export class InvalidUploadPathMetadataFileHashError extends InvalidUploadPathMetadataHashError {
	constructor(cause: InvalidNixSha256HashError) {
		super('file hash must be a sha256 Nix base32 hash', cause);
		this.name = 'InvalidUploadPathMetadataFileHashError';
	}
}

export class InvalidPositiveIntegerError extends ProtocolError {
	constructor(public readonly value: number) {
		super(`Invalid positive integer: ${String(value)}`);
		this.name = 'InvalidPositiveIntegerError';
	}
}

export abstract class InvalidUploadPathMetadataSizeError extends ProtocolError {
	constructor(
		message: string,
		public override readonly cause: InvalidPositiveIntegerError
	) {
		super(message);
		this.name = 'InvalidUploadPathMetadataSizeError';
	}
}

export class InvalidUploadPathMetadataNarSizeError extends InvalidUploadPathMetadataSizeError {
	constructor(cause: InvalidPositiveIntegerError) {
		super('NAR size must be a positive integer', cause);
		this.name = 'InvalidUploadPathMetadataNarSizeError';
	}
}

export class InvalidUploadPathMetadataFileSizeError extends InvalidUploadPathMetadataSizeError {
	constructor(cause: InvalidPositiveIntegerError) {
		super('file size must be a positive integer', cause);
		this.name = 'InvalidUploadPathMetadataFileSizeError';
	}
}

interface UploadPathIdentityFields {
	readonly storePathHash: string;
	readonly storePath: string;
	readonly narHash: string;
	readonly narSize: number;
	readonly references: readonly string[];
}

export class DeletePathRequest {
	private constructor(public readonly storePathHash: string) {}

	static fromFields(fields: DeletePathRequestFields): DeletePathRequest {
		if (!storePathHashPattern.test(fields.storePathHash)) {
			throw new InvalidStorePathHashError(fields.storePathHash);
		}

		return new DeletePathRequest(fields.storePathHash);
	}

	toFields(): DeletePathRequestFields {
		return { storePathHash: this.storePathHash };
	}
}

function validateRootName(name: string): void {
	if (
		name.length === 0 ||
		name.length > rootNameMaxLength ||
		hasControlCharacter(name)
	) {
		throw new InvalidRootNameError(name);
	}
}

function validateRootTtlSeconds(ttlSeconds: number): void {
	if (
		!Number.isInteger(ttlSeconds) ||
		ttlSeconds < rootTtlMinSeconds ||
		ttlSeconds > rootTtlMaxSeconds
	) {
		throw new InvalidRootTtlError(ttlSeconds);
	}
}

interface ResolvedRootTarget {
	readonly storePathHash: string;
	readonly storePath: string;
}

export class RootSetRequest {
	private constructor(
		public readonly name: string,
		public readonly targets: readonly ResolvedRootTarget[],
		public readonly ttlSeconds: number | undefined
	) {}

	static fromFields(fields: RootSetRequestFields): RootSetRequest {
		validateRootName(fields.name);

		if (fields.targets.length === 0) {
			throw new InvalidRootTargetsError();
		}

		// A root is a set: collapse targets that resolve to the same store path
		// hash, keeping the first, so a repeated path is idempotent rather than a
		// primary-key violation downstream.
		const targets: ResolvedRootTarget[] = [];
		const seen = new Set<string>();

		for (const storePath of fields.targets) {
			const storePathHash = StorePath.hash(storePath);

			if (seen.has(storePathHash)) {
				continue;
			}

			seen.add(storePathHash);
			targets.push({ storePathHash, storePath });
		}

		if (fields.ttlSeconds !== undefined) {
			validateRootTtlSeconds(fields.ttlSeconds);
		}

		return new RootSetRequest(fields.name, targets, fields.ttlSeconds);
	}

	toFields(): RootSetRequestFields {
		const fields = {
			name: this.name,
			targets: this.targets.map((target) => target.storePath)
		};

		if (this.ttlSeconds === undefined) {
			return fields;
		}

		return { ...fields, ttlSeconds: this.ttlSeconds };
	}
}

export class RootRemoveRequest {
	private constructor(public readonly name: string) {}

	static fromFields(fields: RootRemoveRequestFields): RootRemoveRequest {
		validateRootName(fields.name);

		return new RootRemoveRequest(fields.name);
	}

	toFields(): RootRemoveRequestFields {
		return { name: this.name };
	}
}

export class UploadPathMetadata {
	constructor(
		public readonly storePathHash: string,
		public readonly storePath: string,
		public readonly narHash: string,
		public readonly narSize: number,
		public readonly references: readonly string[],
		public readonly deriver?: string,
		public readonly ca?: string
	) {
		this.validate();
	}

	static fromFields(fields: UploadPathNegotiationFields): UploadPathMetadata {
		return new UploadPathMetadata(
			fields.storePathHash,
			fields.storePath,
			fields.narHash,
			fields.narSize,
			fields.references,
			fields.deriver,
			fields.ca
		);
	}

	toFields(): UploadPathNegotiationFields {
		return {
			storePathHash: this.storePathHash,
			storePath: this.storePath,
			narHash: this.narHash,
			narSize: this.narSize,
			references: this.references,
			deriver: this.deriver,
			ca: this.ca
		};
	}

	get r2Key(): string {
		return `nar/${this.narHash}.nar.zst`;
	}

	validate(): void {
		validateUploadPathIdentity(this);
	}
}

export class UploadBlobMetadata {
	constructor(
		public readonly fileHash: string,
		public readonly fileSize: number,
		public readonly compression: 'zstd'
	) {
		this.validate();
	}

	static fromFields(fields: UploadBlobMetadataFields): UploadBlobMetadata {
		const compression: unknown = fields.compression;
		validateUploadBlobCompression(compression);

		return new UploadBlobMetadata(
			fields.fileHash,
			fields.fileSize,
			compression
		);
	}

	toFields(): UploadBlobMetadataFields {
		return {
			fileHash: this.fileHash,
			fileSize: this.fileSize,
			compression: this.compression
		};
	}

	validate(): void {
		validateUploadPathFileHash(this.fileHash);
		validateUploadPathFileSize(this.fileSize);
	}
}

export class CacheInfo {
	static readonly default = new CacheInfo('/nix/store', true, 40);

	constructor(
		public readonly storeDirectory: string,
		public readonly wantMassQuery: boolean,
		public readonly priority: number
	) {}

	static fromFields(fields: CacheInfoFields): CacheInfo {
		return new CacheInfo(
			fields.storeDirectory,
			fields.wantMassQuery,
			fields.priority
		);
	}

	render(): string {
		return [
			`StoreDir: ${this.storeDirectory}`,
			`WantMassQuery: ${this.wantMassQuery ? '1' : '0'}`,
			`Priority: ${String(this.priority)}`,
			''
		].join('\n');
	}
}

export class NarInfo {
	constructor(
		public readonly storePath: string,
		public readonly url: string,
		public readonly compression: 'zstd',
		public readonly fileHash: string,
		public readonly fileSize: number,
		public readonly narHash: string,
		public readonly narSize: number,
		public readonly references: readonly string[],
		public readonly deriver?: string,
		public readonly ca?: string,
		public readonly sig?: string
	) {}

	static fromFields(fields: NarInfoFields): NarInfo {
		return new NarInfo(
			fields.storePath,
			fields.url,
			fields.compression,
			fields.fileHash,
			fields.fileSize,
			fields.narHash,
			fields.narSize,
			fields.references,
			fields.deriver,
			fields.ca,
			fields.sig
		);
	}

	static parse(source: string): NarInfo {
		const fields = new Map<string, string>();

		for (const line of source.split(/\r?\n/)) {
			if (line.trim() === '') {
				continue;
			}

			const separator = line.indexOf(':');

			if (separator === -1) {
				throw new InvalidNarInfoLineError(line);
			}

			const key = line.slice(0, separator);
			const value = line.slice(separator + 1).trimStart();
			fields.set(key, value);
		}

		const compression = required(fields, 'Compression');

		if (compression !== 'zstd') {
			throw new UnsupportedNarInfoCompressionError(compression);
		}

		return new NarInfo(
			required(fields, 'StorePath'),
			required(fields, 'URL'),
			compression,
			required(fields, 'FileHash'),
			parseRequiredNarInfoInteger(fields, 'FileSize'),
			required(fields, 'NarHash'),
			parseRequiredNarInfoInteger(fields, 'NarSize'),
			parseReferences(required(fields, 'References')),
			optional(fields, 'Deriver'),
			optional(fields, 'CA'),
			optional(fields, 'Sig')
		);
	}

	fingerprint(): string {
		return [
			'1',
			this.storePath,
			this.narHash,
			String(this.narSize),
			this.referenceStorePaths().join(',')
		].join(';');
	}

	private referenceStorePaths(): readonly string[] {
		const separator = this.storePath.lastIndexOf('/');
		const storeDirectory =
			separator === -1 ? undefined : this.storePath.slice(0, separator);

		// Nix's canonical fingerprint sorts the full reference store paths, so
		// the signature must not depend on the order the references arrive in.
		return this.references
			.map((reference) =>
				storeDirectory === undefined
					? reference
					: `${storeDirectory}/${reference}`
			)
			.toSorted();
	}

	render(): string {
		const lines = [
			`StorePath: ${this.storePath}`,
			`URL: ${this.url}`,
			`Compression: ${this.compression}`,
			`FileHash: ${this.fileHash}`,
			`FileSize: ${String(this.fileSize)}`,
			`NarHash: ${this.narHash}`,
			`NarSize: ${String(this.narSize)}`,
			`References: ${this.references.join(' ')}`
		];

		if (this.deriver !== undefined && this.deriver !== '') {
			lines.push(`Deriver: ${this.deriver}`);
		}

		if (this.ca !== undefined && this.ca !== '') {
			lines.push(`CA: ${this.ca}`);
		}

		if (this.sig !== undefined && this.sig !== '') {
			lines.push(`Sig: ${this.sig}`);
		}

		return `${lines.join('\n')}\n`;
	}

	toFields(): NarInfoFields {
		return {
			storePath: this.storePath,
			url: this.url,
			compression: this.compression,
			fileHash: this.fileHash,
			fileSize: this.fileSize,
			narHash: this.narHash,
			narSize: this.narSize,
			references: this.references,
			deriver: this.deriver,
			ca: this.ca,
			sig: this.sig
		};
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

	static referenceBasenames(references: readonly string[]): readonly string[] {
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

export class UploadPathCommitMetadata {
	constructor(
		public readonly storePathHash: string,
		public readonly storePath: string,
		public readonly narHash: string,
		public readonly narSize: number,
		public readonly fileHash: string,
		public readonly fileSize: number,
		public readonly compression: 'zstd',
		public readonly references: readonly string[],
		public readonly deriver?: string,
		public readonly ca?: string
	) {
		this.validate();
	}

	static fromFields(
		fields: UploadPathMetadataFields
	): UploadPathCommitMetadata {
		const compression: unknown = fields.compression;
		validateUploadBlobCompression(compression);

		return new UploadPathCommitMetadata(
			fields.storePathHash,
			fields.storePath,
			fields.narHash,
			fields.narSize,
			fields.fileHash,
			fields.fileSize,
			compression,
			fields.references,
			fields.deriver,
			fields.ca
		);
	}

	static fromPathAndBlob(
		path: UploadPathMetadata,
		blob: UploadBlobMetadata
	): UploadPathCommitMetadata {
		return new UploadPathCommitMetadata(
			path.storePathHash,
			path.storePath,
			path.narHash,
			path.narSize,
			blob.fileHash,
			blob.fileSize,
			blob.compression,
			path.references,
			path.deriver,
			path.ca
		);
	}

	toFields(): UploadPathMetadataFields {
		return {
			storePathHash: this.storePathHash,
			storePath: this.storePath,
			narHash: this.narHash,
			narSize: this.narSize,
			fileHash: this.fileHash,
			fileSize: this.fileSize,
			compression: this.compression,
			references: this.references,
			deriver: this.deriver,
			ca: this.ca
		};
	}

	get r2Key(): string {
		return `nar/${this.narHash}.nar.zst`;
	}

	validate(): void {
		validateUploadPathIdentity(this);
		validateUploadPathFileHash(this.fileHash);
		validateUploadPathFileSize(this.fileSize);
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

function parseReferences(value: string): readonly string[] {
	return value.split(/\s+/).filter((reference) => reference !== '');
}

function required(fields: ReadonlyMap<string, string>, key: string): string {
	const value = fields.get(key);

	if (value === undefined) {
		throw new MissingNarInfoFieldError(key);
	}

	return value;
}

function optional(
	fields: ReadonlyMap<string, string>,
	key: string
): string | undefined {
	const value = fields.get(key);

	return value === undefined || value === '' ? undefined : value;
}

function parseRequiredNarInfoInteger(
	fields: ReadonlyMap<string, string>,
	key: NarInfoIntegerField
): number {
	const raw = required(fields, key);

	// Only a run of digits — `Number.parseInt` would otherwise accept trailing
	// junk ("123abc" -> 123, "1e9" -> 1).
	if (!/^\d+$/.test(raw)) {
		throw new InvalidNarInfoIntegerFieldError(key);
	}

	const value = Number.parseInt(raw, 10);

	if (!Number.isSafeInteger(value)) {
		throw new InvalidNarInfoIntegerFieldError(key);
	}

	return value;
}

function validateUploadPathNarHash(value: string): void {
	try {
		validateHash(value);
	} catch (error) {
		if (error instanceof InvalidNixSha256HashError) {
			throw new InvalidUploadPathMetadataNarHashError(error);
		}

		throw error;
	}
}

function validateUploadPathFileHash(value: string): void {
	try {
		validateHash(value);
	} catch (error) {
		if (error instanceof InvalidNixSha256HashError) {
			throw new InvalidUploadPathMetadataFileHashError(error);
		}

		throw error;
	}
}

function validateUploadBlobCompression(
	value: unknown
): asserts value is 'zstd' {
	if (value === 'zstd') {
		return;
	}

	throw new UnsupportedUploadBlobCompressionError(value);
}

function validateUploadPathIdentity(fields: UploadPathIdentityFields): void {
	if (!/^[0-9a-df-np-sv-z]{32}$/.test(fields.storePathHash)) {
		throw new InvalidStorePathHashError(fields.storePathHash);
	}

	const storePathHash = StorePath.hash(fields.storePath);

	if (storePathHash !== fields.storePathHash) {
		throw new StorePathHashMismatchError(
			fields.storePath,
			fields.storePathHash,
			storePathHash
		);
	}

	validateUploadPathNarHash(fields.narHash);
	validateUploadPathNarSize(fields.narSize);

	for (const reference of fields.references) {
		if (reference.includes('/')) {
			throw new InvalidStorePathReferenceError(reference);
		}
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

function validateHash(value: string): void {
	NixSha256Hash.parse(value);
}

function validateUploadPathNarSize(value: number): void {
	try {
		validatePositiveInteger(value);
	} catch (error) {
		if (error instanceof InvalidPositiveIntegerError) {
			throw new InvalidUploadPathMetadataNarSizeError(error);
		}

		throw error;
	}
}

function validateUploadPathFileSize(value: number): void {
	try {
		validatePositiveInteger(value);
	} catch (error) {
		if (error instanceof InvalidPositiveIntegerError) {
			throw new InvalidUploadPathMetadataFileSizeError(error);
		}

		throw error;
	}
}

function validatePositiveInteger(value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new InvalidPositiveIntegerError(value);
	}
}
