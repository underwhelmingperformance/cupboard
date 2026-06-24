import { type SigningKeyId } from '@cupboard/nix/scalars';
import {
	type KeyListResponse,
	type KeyRetireResponse,
	type KeyRotateResponse,
	type SigningKeyStage
} from '@cupboard/protocol/keys';
import { eq } from 'drizzle-orm';

import { generateSigningKey } from '../crypto/crypto.ts';
import * as schema from '../db/schema.ts';
import { LastSigningKeyError } from '../errors.ts';
import { TextBody } from '../http/http.ts';

import { type ServerContext } from './context.ts';
import {
	bootstrapKeyName,
	byPublicKey,
	keySummary,
	nextKeyName,
	type SigningKey,
	signingKeyFromRow
} from './signing-keys.ts';

export class SigningKeysService {
	private keysPromise: Promise<readonly SigningKey[]> | undefined;
	private publicKeyBody: TextBody | undefined;

	constructor(private readonly context: ServerContext) {}

	private loadedKeys(): Promise<readonly SigningKey[]> {
		// A shared in-flight promise so concurrent first requests against an
		// empty DO generate and insert the bootstrap key exactly once. A failed
		// attempt clears the cache so a later request can create it.
		this.keysPromise ??= this.loadOrCreateKeysTracked();

		return this.keysPromise;
	}

	private async loadOrCreateKeysTracked(): Promise<readonly SigningKey[]> {
		try {
			return await this.loadOrCreateKeys();
		} catch (error: unknown) {
			this.keysPromise = undefined;
			throw error;
		}
	}

	private async loadOrCreateKeys(): Promise<readonly SigningKey[]> {
		const rows = this.context.db.select().from(schema.signingKeys).all();

		if (rows.length > 0) {
			return rows.map((row) => signingKeyFromRow(row)).toSorted(byPublicKey);
		}

		const generated = await generateSigningKey(bootstrapKeyName);
		const now = new Date();
		const createdAt = now.toISOString();

		this.context.db
			.insert(schema.signingKeys)
			.values({
				id: 'active',
				privateJwkJson: JSON.stringify(generated.privateJwk),
				publicKey: generated.publicKey,
				signing: true,
				published: true,
				createdAt
			})
			.run();

		return [
			{
				id: 'active',
				name: bootstrapKeyName,
				privateJwk: generated.privateJwk,
				publicKey: generated.publicKey,
				signing: true,
				published: true,
				createdAt
			}
		];
	}

	private async publishedKeys(): Promise<readonly SigningKey[]> {
		const keys = await this.loadedKeys();

		return keys.filter((key) => key.published);
	}

	private async publishedKeysText(): Promise<string> {
		const keys = await this.publishedKeys();

		return keys.map((key) => key.publicKey).join('\n');
	}

	resetKeyCaches(): void {
		this.keysPromise = undefined;
		this.publicKeyBody = undefined;
	}

	rotateKey(): Promise<KeyRotateResponse> {
		// One critical section: the read of the existing names, the insert, and
		// the cache reset must not interleave with a concurrent rotation or a
		// commit reading the key set.
		return this.context.ctx.blockConcurrencyWhile(async () => {
			const existing = await this.loadedKeys();
			const generated = await generateSigningKey(nextKeyName(existing));
			const id = crypto.randomUUID();
			const rotationCreatedAt = new Date();

			this.context.db
				.insert(schema.signingKeys)
				.values({
					id,
					privateJwkJson: JSON.stringify(generated.privateJwk),
					publicKey: generated.publicKey,
					signing: true,
					published: true,
					createdAt: rotationCreatedAt.toISOString()
				})
				.run();

			this.resetKeyCaches();

			const keys = await this.loadedKeys();
			const rotated = keys.find((key) => key.id === id);

			if (rotated === undefined) {
				throw new Error('rotated key vanished immediately after insert');
			}

			return {
				rotated: keySummary(rotated),
				keys: keys.map((key) => keySummary(key))
			};
		});
	}

	async retireKey(id: SigningKeyId): Promise<KeyRetireResponse> {
		// The last-signing-key check and the demotion share one critical section
		// so two concurrent retirements cannot both see themselves as safe. A
		// refused retirement is reported as an outcome and thrown afterwards:
		// throwing inside blockConcurrencyWhile would break the input gate.
		const outcome = await this.context.ctx.blockConcurrencyWhile(
			async (): Promise<{ stage: SigningKeyStage } | { refused: true }> => {
				const keys = await this.loadedKeys();
				const key = keys.find((candidate) => candidate.id === id);

				if (key === undefined) {
					return { stage: 'absent' };
				}

				if (key.signing) {
					const signingCount = keys.filter(
						(candidate) => candidate.signing
					).length;

					if (signingCount <= 1) {
						return { refused: true };
					}

					this.context.db
						.update(schema.signingKeys)
						.set({ signing: false })
						.where(eq(schema.signingKeys.id, id))
						.run();
					this.resetKeyCaches();

					return { stage: 'publication' };
				}

				this.context.db
					.delete(schema.signingKeys)
					.where(eq(schema.signingKeys.id, id))
					.run();
				this.resetKeyCaches();

				return { stage: 'absent' };
			}
		);

		if ('refused' in outcome) {
			throw new LastSigningKeyError(id);
		}

		return { id, stage: outcome.stage };
	}

	async keyList(): Promise<KeyListResponse> {
		const keys = await this.loadedKeys();

		return { keys: keys.map((key) => keySummary(key)) };
	}

	async signingKeys(): Promise<readonly SigningKey[]> {
		const keys = await this.loadedKeys();

		return keys.filter((key) => key.signing);
	}

	async publishedKeysBody(): Promise<TextBody> {
		this.publicKeyBody ??= new TextBody(`${await this.publishedKeysText()}\n`);

		return this.publicKeyBody;
	}
}
