import { NextRequest, NextResponse } from "next/server";
import {
  AgentDispatchClient,
  RoomServiceClient,
} from "livekit-server-sdk";

export async function DELETE(request: NextRequest) {
  try {
    const roomName = request.nextUrl.searchParams.get("room-name");
    const agentName =
      process.env.NEXT_PUBLIC_AGENT_NAME ||
      process.env.LIVEKIT_AGENT_NAME ||
      "baskin-avatar";

    console.log("stopping agent...");
    console.log("roomName:", roomName);
    console.log("agentName:", agentName);

    if (!roomName) {
      return NextResponse.json(
        { error: "Room name is required" },
        { status: 400 }
      );
    }

    if (!agentName) {
      return NextResponse.json(
        { error: "Agent name is required" },
        { status: 400 }
      );
    }

    const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;

    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      return NextResponse.json(
        { error: "Server configuration is missing" },
        { status: 500 }
      );
    }

    const roomServiceClient = new RoomServiceClient(
      LIVEKIT_URL,
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET
    );

    // Check if other guests are still in the room before killing the dispatch
    try {
      const participants = await roomServiceClient.listParticipants(roomName);
      const guestCount = participants.filter(
        (p) =>
          p.identity?.startsWith("guest-") ||
          p.identity?.startsWith("guest_")
      ).length;

      if (guestCount > 1) {
        console.log(
          `Skipping dispatch deletion: ${guestCount} guests still in room ${roomName}`
        );
        return NextResponse.json({
          status: "skipped",
          message: "Other guests still in room, dispatch preserved",
        });
      }
    } catch (err) {
      // If room doesn't exist anymore, proceed with cleanup
      console.warn("Could not list participants, proceeding with cleanup:", err);
    }

    const agentDispatchClient = new AgentDispatchClient(
      LIVEKIT_URL,
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET
    );

    const dispatches = await agentDispatchClient.listDispatch(roomName);
    const dispatch = dispatches.find((candidate) => {
      if (candidate.agentName !== agentName) return false;
      const deletedAt = candidate.state?.deletedAt;
      if (deletedAt === undefined) return true;
      if (typeof deletedAt === "bigint") {
        return Number(deletedAt) === 0;
      }
      return deletedAt === 0;
    });

    if (!dispatch) {
      return NextResponse.json({
        status: "success",
        message: "No active agent dispatch for this room",
      });
    }

    try {
      await agentDispatchClient.deleteDispatch(dispatch.id, roomName);
    } catch (err) {
      if (err instanceof Error && (err as { code?: string }).code === "not_found") {
        return NextResponse.json({
          status: "success",
          message: "Agent dispatch already removed",
        });
      }
      throw err;
    }

    return NextResponse.json({
      status: "success",
      message: "Agent dispatch has been deleted for the room",
    });
  } catch (error) {
    console.error("Error stopping agent:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
