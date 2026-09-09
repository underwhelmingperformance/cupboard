import { readFileSync } from 'node:fs';
import path from 'node:path';

import { subrequestsPerInvocation } from '@cupboard/protocol/platform';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.join(import.meta.dirname, '..');

const wranglerFiles = [
	'packages/server/wrangler.jsonc',
	'packages/server/wrangler.tenant.jsonc'
];

function hasPinnedSubrequests(file: string): boolean {
	const text = readFileSync(path.join(repositoryRoot, file), 'utf8');

	return /"subrequests":\s*\d+/u.test(text);
}

describe('the subrequest ceiling', () => {
	it('uses the Free internal-service allowance without a static pin', () => {
		expect({
			free: subrequestsPerInvocation,
			pins: Object.fromEntries(
				wranglerFiles.map((file) => [file, hasPinnedSubrequests(file)])
			)
		}).toStrictEqual({
			free: 1000,
			pins: {
				'packages/server/wrangler.jsonc': false,
				'packages/server/wrangler.tenant.jsonc': false
			}
		});
	});
});
