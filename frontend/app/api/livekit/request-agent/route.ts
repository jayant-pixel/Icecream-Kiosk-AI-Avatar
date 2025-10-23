import { NextRequest, NextResponse } from "next/server";
import {
  AgentDispatchClient,
  RoomServiceClient,
} from "livekit-server-sdk";

const AGENT_METADATA = { requestedBy: "meet-app" };

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { room } = body ?? {};

    if (!room || typeof room !== "string") {
      return NextResponse.json(
        { error: "Room name is required" },
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

    const roomName = room;
    const agentName = process.env.NEXT_PUBLIC_AGENT_NAME || "livekit-agent";

    const agentDispatchClient = new AgentDispatchClient(
      LIVEKIT_URL,
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET
    );
    const roomServiceClient = new RoomServiceClient(
      LIVEKIT_URL,
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET
    );

    await ensureRoomExists(roomServiceClient, roomName);

    const dispatches = await agentDispatchClient.listDispatch(roomName);
    const existingDispatch = dispatches.find((dispatch) => {
      if (dispatch.agentName !== agentName) return false;
      const deletedAt = dispatch.state?.deletedAt;
      if (deletedAt === undefined) return true;
      if (typeof deletedAt === "bigint") {
        return Number(deletedAt) === 0;
      }
      return deletedAt === 0;
    });

    if (existingDispatch) {
      console.log("Dispatch already active", existingDispatch.id);
      return NextResponse.json({ success: true });
    }

    await agentDispatchClient.createDispatch(roomName, agentName, {
      metadata: JSON.stringify(AGENT_METADATA),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error requesting agent:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

async function ensureRoomExists(
  client: RoomServiceClient,
  roomName: string
): Promise<void> {
  try {
    const rooms = await client.listRooms([roomName]);
    if (rooms.some((room) => room.name === roomName)) {
      return;
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code && code !== "not_found") {
      throw err;
    }
  }

  try {
    await client.createRoom({ name: roomName });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "already_exists") {
      throw err;
    }
  }
}
