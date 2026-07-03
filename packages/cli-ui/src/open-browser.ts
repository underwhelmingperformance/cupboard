import { spawn } from 'node:child_process';
import { platform } from 'node:process';

/** Where the launch narrates itself; satisfied by any reporter-like sink. */
export interface BrowserMessages {
	info(message: string): void;
	warn(message: string): void;
}

/**
 * Best-effort browser launch: the URL is always printed, so a failed or absent
 * opener still leaves the user a link to follow.
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
