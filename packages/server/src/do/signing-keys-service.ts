import { signingKeyIdSchema } from '@cupboard/nix/scalars';
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
import { parseRequestValue } from '../http/parse.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import {
	bootstrapKeyName,
	byPublicKey,
	keySummary,
	nextKeyName,
	type ServerContext,
	type SigningKey,
	signingKeyFromRow
} from './context.ts';

export class SigningKeysService {
	private keysPromise: Promise<readonly SigningKey[]> | undefined;
	private publicKeyBody: TextBody | undefined;

	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService
	) {}

	async handleKeyList(request: Request): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		return Response.json((await this.keyList()) satisfies KeyListResponse);
	}

	async handleKeyRotate(request: Request): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		return Response.json((await this.rotateKey()) satisfies KeyRotateResponse);
	}

	async handleKeyRetire(request: Request, id: string): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		const keyId = parseRequestValue(signingKeyIdSchema, id);

		return Response.json(
			(await this.retireKey(keyId)) satisfies KeyRetireResponse
		);
	}

	private loadedKeys(): Promise<readonly SigningKey[]> {
		// A shared in-flight promise so concurrent first requests against an
		// empty DO generate and insert the bootstrap key exactly once. A failed
		// attempt clears the cache so a later request can create it.
		this.keysPromise ??= this.loadOrCreateKeys().catch((error: unknown) => {
			this.keysPromise = undefined;
			throw error;
		});

		return this.keysPromise;
	}

	private async loadOrCreateKeys(): Promise<readonly SigningKey[]> {
		const rows = this.context.db.select().from(schema.signingKeys).all();

		if (rows.length > 0) {
			return rows.map((row) => signingKeyFromRow(row)).toSorted(byPublicKey);
		}

		const generated = await generateSigningKey(bootstrapKeyName);
		const createdAt = new Date().toISOString();

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

	resetKeyCaches(): void {
		this.keysPromise = undefined;
		this.publicKeyBody = undefined;
	}

	private rotateKey(): Promise<KeyRotateResponse> {
		// One critical section: the read of the existing names, the insert, and
		// the cache reset must not interleave with a concurrent rotation or a
		// commit reading the key set.
		return this.context.ctx.blockConcurrencyWhile(async () => {
			const existing = await this.loadedKeys();
			const generated = await generateSigningKey(nextKeyName(existing));
			const id = crypto.randomUUID();

			this.context.db
				.insert(schema.signingKeys)
				.values({
					id,
					privateJwkJson: JSON.stringify(generated.privateJwk),
					publicKey: generated.publicKey,
					signing: true,
					published: true,
					createdAt: new Date().toISOString()
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

	private async retireKey(id: string): Promise<KeyRetireResponse> {
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

	private async keyList(): Promise<KeyListResponse> {
		const keys = await this.loadedKeys();

		return { keys: keys.map((key) => keySummary(key)) };
	}

	async signingKeys(): Promise<readonly SigningKey[]> {
		const keys = await this.loadedKeys();

		return keys.filter((key) => key.signing);
	}

	private async publishedKeys(): Promise<readonly SigningKey[]> {
		const keys = await this.loadedKeys();

		return keys.filter((key) => key.published);
	}

	private async publishedKeysText(): Promise<string> {
		const keys = await this.publishedKeys();

		return keys.map((key) => key.publicKey).join('\n');
	}

	async publishedKeysBody(): Promise<TextBody> {
		this.publicKeyBody ??= new TextBody(`${await this.publishedKeysText()}\n`);

		return this.publicKeyBody;
	}
}
