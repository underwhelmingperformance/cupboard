import { spawn } from 'node:child_process';
import { platform } from 'node:process';

import {
	observeChildProcess,
	waitForChildProcess
} from '@cupboard/shared/child-process';

/**
Where {@link openBrowser} writes its messages; any reporter satisfies it.
*/
export interface BrowserMessages {
	info(message: string): void;
	warn(message: string): void;
}

/**
 * Prints the URL and starts the platform opener. The function returns without
 * waiting, then reports a warning if the process cannot start or exits
 * unsuccessfully.
 */
export function openBrowser(target: string, messages: BrowserMessages): void {
	messages.info(`Opening your browser to:\n${target}`);

	const launch = browserLaunch(platform, target);
	const child = spawn(launch.command, launch.args, {
		stdio: 'ignore',
		detached: true
	});
	const completion = waitForChildProcess(observeChildProcess(child));
	void completion.then(({ error, signal, status }) => {
		if (error === undefined && signal === undefined && status === 0) {
			return;
		}

		messages.warn(
			'Could not open a browser automatically; open the URL above yourself.'
		);
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
