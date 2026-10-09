import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import { generateAuthKeyPair } from '../auth/auth.ts';
import { testControlDatabase } from '../control-database.test-support.ts';
import { parseJwk } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { ControlDatabaseInvalidError } from '../errors.ts';
import { testControlEnv } from '../test-support.ts';

import { unwrapControlPrivateJwk } from './control-key.ts';
import { ensureControlKey } from './control-key-store.ts';
import { validateControlDatabase } from './database-validation.ts';

const target = () => drizzleD1(testControlDatabase(), { schema: d1Schema });
const wrappingSecret = testControlEnv.CONTROL_KEY_WRAP_SECRET;

function validationEnv(): Pick<Env, 'CONTROL_DB' | 'CONTROL_KEY_WRAP_SECRET'> {
	return {
		CONTROL_DB: testControlDatabase(),
		CONTROL_KEY_WRAP_SECRET: wrappingSecret
	};
}

async function seedKey(): Promise<typeof d1Schema.controlAuthKey.$inferSelect> {
	await ensureControlKey(
		target(),
		wrappingSecret,
		isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
	);
	const row = await target().select().from(d1Schema.controlAuthKey).get();

	if (row === undefined) {
		throw new Error('The target signing key was not created.');
	}

	return row;
}

describe('copied control signing keys', () => {
	it('accepts an empty fresh database and matching key material', async () => {
		const fresh = await validateControlDatabase(validationEnv());
		await seedKey();
		const copied = await validateControlDatabase(validationEnv());

		expect({ fresh, copied }).toStrictEqual({
			fresh: { valid: true },
			copied: { valid: true }
		});
	});

	it.each([
		'mismatched-public-key',
		'private-public-key',
		'unsupported-algorithm',
		'duplicate-kid',
		'malformed-envelope'
	] as const)(
		'rejects %s before activating the copied database',
		async (fault) => {
			const row = await seedKey();

			switch (fault) {
				case 'mismatched-public-key': {
					const replacement = await generateAuthKeyPair();
					await target()
						.update(d1Schema.controlAuthKey)
						.set({ publicJwkJson: JSON.stringify(replacement.publicJwk) });
					break;
				}
				case 'private-public-key': {
					const privateJwk = await unwrapControlPrivateJwk(
						wrappingSecret,
						row.wrappedPrivateJwk
					);
					const publicJwkJson = JSON.stringify(privateJwk);
					await target().update(d1Schema.controlAuthKey).set({ publicJwkJson });
					break;
				}
				case 'unsupported-algorithm': {
					const publicJwk = parseJwk(row.publicJwkJson);
					const publicJwkJson = JSON.stringify({ ...publicJwk, alg: 'HS256' });
					await target().update(d1Schema.controlAuthKey).set({ publicJwkJson });
					break;
				}
				case 'duplicate-kid': {
					await target()
						.insert(d1Schema.controlAuthKey)
						.values({ ...row, id: 'duplicate' });
					break;
				}
				case 'malformed-envelope': {
					await target()
						.update(d1Schema.controlAuthKey)
						.set({ wrappedPrivateJwk: 'invalid' });
					break;
				}
			}

			await expect(validateControlDatabase(validationEnv())).rejects.toThrow(
				ControlDatabaseInvalidError
			);
		}
	);

	it('rejects copied key material under a different wrapping secret', async () => {
		await seedKey();

		const incorrectSecret = btoa('x'.repeat(32));
		await expect(
			validateControlDatabase({
				...validationEnv(),
				CONTROL_KEY_WRAP_SECRET: incorrectSecret
			})
		).rejects.toThrow(ControlDatabaseInvalidError);
	});
});
