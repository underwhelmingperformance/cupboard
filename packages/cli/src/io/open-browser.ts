import { spawn } from 'node:child_process';
import { platform } from 'node:process';

import type { Reporter } from '@cupboard/reporter';

/**
 * Best-effort browser launch: the URL is always printed, so a failed or absent
 * opener leaves the user a link to follow rather than a dead end.
 */
export function openBrowser(target: string, reporter: Reporter): void {
	reporter.info(`Opening your browser to:\n${target}`);

	const launch = browserLaunch(platform, target);
	const child = spawn(launch.command, launch.args, {
		stdio: 'ignore',
		detached: true
	});
	child.on('error', () => {
		reporter.warn('Could not open a browser automatically');
	});
	child.unref();
}

function browserLaunch(
	os: NodeJS.Platform,
	target: string
): { readonly command: string; readonly args: readonly string[] } {
	if (os === 'darwin') {
		return { command: 'open', args: [target] };
	}

	if (os === 'win32') {
		return { command: 'cmd', args: ['/c', 'start', '', target] };
	}

	return { command: 'xdg-open', args: [target] };
}
