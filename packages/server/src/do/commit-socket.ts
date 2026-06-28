import type { CommitSessionFrame } from '@cupboard/protocol/upload';

// One encoder for every frame the commit session carries, so the protocol
// module's schema stays the single source of the wire shape.
export function sendCommitSessionFrame(
	socket: WebSocket,
	frame: CommitSessionFrame
): void {
	socket.send(JSON.stringify(frame));
}
