import type { CommitSocketFrame } from '@cupboard/protocol/upload';

// One encoder for every frame the commit socket carries, so the protocol
// module's schema stays the single source of the wire shape.
export function sendCommitFrame(
	socket: WebSocket,
	frame: CommitSocketFrame
): void {
	socket.send(JSON.stringify(frame));
}
