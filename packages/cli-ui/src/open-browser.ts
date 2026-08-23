import { spawn } from 'node:child_process';
import { platform } from 'node:process';

export interface BrowserMessages {
	info(message: string): void;
	warn(message: string): void;
}

/**
 * Prints the URL, then starts the platform opener without waiting for it. A
 * warning reports only a failure to spawn the child process; the opener's later
 * exit status is not observed.
 */
export function openBrowser(target: string, messages: BrowserMessages): void {
	messages.info(`Opening your browser to:\n${target}`);

	const launch = browserLaunch(platform, target);
	const child = spawn(launch.command, launch.args, {
		stdio: 'ignore',
		detached: true
	});
	child.on('error', () => {
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
