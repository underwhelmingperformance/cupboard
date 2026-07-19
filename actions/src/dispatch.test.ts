import { describe, expect, it } from 'vitest';

import { dispatch } from './dispatch.ts';
import { UnknownCommandError } from './errors.ts';

describe('dispatch', () => {
	it.each([['frobnicate'], ['']])(
		'rejects the unknown command %p',
		async (command) => {
			await expect(dispatch(command, {})).rejects.toThrow(UnknownCommandError);
		}
	);

	it('rejects a missing command', async () => {
		await expect(dispatch(undefined, {})).rejects.toThrow(UnknownCommandError);
	});
});
