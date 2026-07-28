import { describe, expect, it } from 'vitest';

import { CacheInfo, servedStoreDirectory } from './cache-info.ts';
import { CacheInfoParseError } from './errors.ts';
import { cachePrioritySchema, storeDirectorySchema } from './scalars.ts';

const priority = (value: number) => cachePrioritySchema.parse(value);
const store = (value: string) => storeDirectorySchema.parse(value);

describe('CacheInfo', () => {
	it('renders nix-cache-info', () => {
		expect(CacheInfo.default.render()).toBe(
			['StoreDir: /nix/store', 'WantMassQuery: 1', 'Priority: 40', ''].join(
				'\n'
			)
		);
	});

	it('parses its own rendering back', () => {
		const info = new CacheInfo(servedStoreDirectory, true, priority(50));

		expect(CacheInfo.parse(info.render())).toStrictEqual(info);
	});

	it.each([
		{
			name: 'fields in any order with extra whitespace',
			text: 'Priority: 30\nStoreDir:  /nix/store\nWantMassQuery: 0\n',
			expected: new CacheInfo(servedStoreDirectory, false, priority(30))
		},
		{
			name: 'unknown lines ignored',
			text: 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\nFuture: x\n',
			expected: new CacheInfo(servedStoreDirectory, true, priority(40))
		},
		{
			name: 'a cache serving another store directory',
			text: 'StoreDir: /home/laney/nixstore\nWantMassQuery: 1\nPriority: 40\n',
			expected: new CacheInfo(store('/home/laney/nixstore'), true, priority(40))
		},
		{
			name: 'a cache serving a nested store directory',
			text: 'StoreDir: /var/lib/cupboard/nix/store\nWantMassQuery: 0\nPriority: 25\n',
			expected: new CacheInfo(
				store('/var/lib/cupboard/nix/store'),
				false,
				priority(25)
			)
		}
	])('parses $name', ({ text, expected }) => {
		expect(CacheInfo.parse(text)).toStrictEqual(expected);
	});
});

describe('CacheInfo.parse', () => {
	it('round-trips a rendered document', () => {
		const rendered = new CacheInfo(
			servedStoreDirectory,
			true,
			priority(41)
		).render();

		expect(CacheInfo.parse(rendered)).toStrictEqual(
			new CacheInfo(servedStoreDirectory, true, priority(41))
		);
	});

	it('parses a document with extra fields and windows line endings', () => {
		const source =
			'StoreDir: /nix/store\r\nWantMassQuery: 0\r\nPriority: 30\r\nExtra: 1\r\n';

		expect(CacheInfo.parse(source)).toStrictEqual(
			new CacheInfo(servedStoreDirectory, false, priority(30))
		);
	});

	it('reads a missing WantMassQuery as disabled', () => {
		expect(
			CacheInfo.parse('StoreDir: /nix/store\nPriority: 40\n')
		).toStrictEqual(new CacheInfo(servedStoreDirectory, false, priority(40)));
	});

	it.each([
		['StoreDir', 'WantMassQuery: 1\nPriority: 40\n'],
		['StoreDir', ''],
		['StoreDir', 'StoreDir: nix/store\nWantMassQuery: 1\nPriority: 40\n'],
		['StoreDir', 'StoreDir: /\nWantMassQuery: 1\nPriority: 40\n'],
		[
			'WantMassQuery',
			'StoreDir: /nix/store\nWantMassQuery: maybe\nPriority: 40\n'
		],
		['Priority', 'StoreDir: /nix/store\nWantMassQuery: 1\n'],
		['Priority', 'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: soon\n'],
		['Priority', 'StoreDir: /nix/store\nPriority:\n'],
		['Priority', 'StoreDir: /nix/store\nPriority: 0x10\n'],
		['Priority', 'StoreDir: /nix/store\nPriority: 1e2\n'],
		['Priority', 'StoreDir: /nix/store\nPriority: 9007199254740993\n']
	])('refuses a document with a bad %s', (field, source) => {
		let failure: unknown;

		try {
			CacheInfo.parse(source);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(CacheInfoParseError);

		if (failure instanceof CacheInfoParseError) {
			expect(failure.field).toBe(field);
		}
	});
});
