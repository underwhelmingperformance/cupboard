import { storePathSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { copySources } from './activity-log.ts';

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const libraryPath = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
);

// Nix starts a copy with a record whose fields are the store path, the store
// the bytes come from and the store they go to.
function copyLine(
	storePath: string,
	source: string,
	destination = 'local'
): string {
	return JSON.stringify({
		action: 'start',
		id: 2,
		level: 3,
		parent: 0,
		text: `copying path '${storePath}' from '${source}' to '${destination}'`,
		type: 100,
		fields: [storePath, source, destination]
	});
}

describe('copySources', () => {
	it.each([
		{
			name: 'one source per copied path',
			logs: [
				[
					copyLine(appPath, 'https://cache.nixos.org'),
					copyLine(libraryPath, 'ssh://builder-1')
				].join('\n')
			],
			expected: new Map([
				[appPath, ['https://cache.nixos.org']],
				[libraryPath, ['ssh://builder-1']]
			])
		},
		{
			name: 'each source of a path copied more than once, in the logged order',
			logs: [
				[
					copyLine(appPath, 'https://first.example'),
					copyLine(appPath, 'https://second.example'),
					copyLine(appPath, 'https://first.example')
				].join('\n')
			],
			expected: new Map([
				[appPath, ['https://first.example', 'https://second.example']]
			])
		},
		{
			name: 'the sources from the logs of every attempt in one run',
			logs: [
				copyLine(appPath, 'https://first.example'),
				copyLine(appPath, 'https://second.example')
			],
			expected: new Map([
				[appPath, ['https://first.example', 'https://second.example']]
			])
		},
		{
			name: 'nothing from a record of any other shape',
			logs: [
				[
					'not json at all',
					JSON.stringify({ action: 'stop', id: 2 }),
					JSON.stringify({
						action: 'start',
						type: 108,
						fields: [appPath, 'https://cache.nixos.org']
					}),
					JSON.stringify({
						action: 'start',
						type: 100,
						fields: ['plain', 'https://cache.nixos.org', 'local']
					}),
					JSON.stringify({
						action: 'start',
						type: 100,
						fields: [appPath, '', 'local']
					}),
					''
				].join('\n')
			],
			expected: new Map()
		},
		{
			name: 'nothing for a run with no log at all',
			logs: [],
			expected: new Map()
		}
	])('records $name', ({ logs, expected }) => {
		expect(copySources(logs)).toStrictEqual(expected);
	});
});
