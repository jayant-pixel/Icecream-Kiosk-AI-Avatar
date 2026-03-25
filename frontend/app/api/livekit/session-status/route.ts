import { NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";

/**
 * GET /api/livekit/session-status
 *
 * Checks whether any active kiosk session is currently running.
 * Returns { available: true } if no active sessions, or
 * { available: false } if a session is in progress.
 *
 * This is used to gate entry when the Simli avatar service
 * only supports one concurrent session.
 */
export async function GET() {
    try {
        const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;

        if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
            return NextResponse.json(
                { error: "Server configuration is missing" },
                { status: 500 }
            );
        }

        const roomService = new RoomServiceClient(
            LIVEKIT_URL,
            LIVEKIT_API_KEY,
            LIVEKIT_API_SECRET
        );

        // List all rooms and check for active kiosk sessions
        const rooms = await roomService.listRooms();
        const activeKioskRooms = rooms.filter((room) =>
            room.name.startsWith("kiosk-")
        );

        // Check if any kiosk room has both a guest and an agent participant
        for (const room of activeKioskRooms) {
            try {
                const participants = await roomService.listParticipants(room.name);
                const hasGuest = participants.some(
                    (p) =>
                        p.identity?.startsWith("guest-") ||
                        p.identity?.startsWith("guest_")
                );
                const hasAgent = participants.some(
                    (p) =>
                        p.identity?.includes("avatar") ||
                        p.identity?.includes("baskin") ||
                        p.attributes?.role === "agent"
                );

                if (hasGuest && hasAgent) {
                    return NextResponse.json({
                        available: false,
                        message:
                            "Another guest is currently being served. Please wait a moment — your turn is coming up!",
                    });
                }
            } catch {
                // Room may have been cleaned up between listing and checking
                continue;
            }
        }

        return NextResponse.json({ available: true });
    } catch (error) {
        console.error("Error checking session status:", error);
        // If we can't check, allow entry (fail-open) — the Simli error
        // will be caught later if a session is truly unavailable
        return NextResponse.json({ available: true });
    }
}
