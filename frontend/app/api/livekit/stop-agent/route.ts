import { NextRequest, NextResponse } from "next/server";
import {
  AgentDispatchClient,
  // RoomServiceClient
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

    // const roomServiceClient = new RoomServiceClient(
    //   LIVEKIT_URL,
    //   LIVEKIT_API_KEY,
    //   LIVEKIT_API_SECRET
    // );
    // const listParticipants = await roomServiceClient.listParticipants(roomName);
    // console.log("listParticipants:", listParticipants);
    // const participant = listParticipants.find(
    //   (participant) =>
    //     participant.kind === 4 &&
    //     participant.attributes?.agentName === agentName
    // );
    // if (participant) {
    //   await roomServiceClient.removeParticipant(roomName, participant.identity);
    // } else {
    //   return NextResponse.json(
    //     { error: "Agent participant not found in the room" },
    //     { status: 404 }
    //   );
    // }

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
