import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.join(import.meta.dirname, '..');
const wranglerFiles = [
	'packages/server/wrangler.jsonc',
	'packages/server/wrangler.tenant.jsonc'
];

describe('the deployed subrequest allowance', () => {
	it('uses plan defaults in both Worker configurations', () => {
		const configuration = Object.fromEntries(
			wranglerFiles.map((file) => {
				const text = readFileSync(path.join(repositoryRoot, file), 'utf8');

				return [
					file,
					{
						binding: text.includes('"CUPBOARD_SUBREQUESTS_PER_INVOCATION"'),
						pinned: /"subrequests":\s*\d+/u.test(text)
					}
				];
			})
		);

		expect(configuration).toStrictEqual({
			'packages/server/wrangler.jsonc': { binding: true, pinned: false },
			'packages/server/wrangler.tenant.jsonc': {
				binding: true,
				pinned: false
			}
		});
	});
});
