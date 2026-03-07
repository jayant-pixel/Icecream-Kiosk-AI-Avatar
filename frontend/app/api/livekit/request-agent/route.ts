import { NextRequest, NextResponse } from "next/server";
import {
  AgentDispatchClient,
  RoomServiceClient,
} from "livekit-server-sdk";

const AGENT_METADATA = { requestedBy: "meet-app" };

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { room, language } = body ?? {};

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
    const selectedLanguage = typeof language === "string" ? language : "english";
    const agentName = process.env.NEXT_PUBLIC_AGENT_NAME;

    if (!agentName) {
      console.error("NEXT_PUBLIC_AGENT_NAME environment variable is required");
      return NextResponse.json(
        { error: "Agent name not configured" },
        { status: 500 }
      );
    }

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

    // Create room with language metadata so the agent can read it
    const roomMetadata = JSON.stringify({ language: selectedLanguage });
    await ensureRoomExists(roomServiceClient, roomName, roomMetadata);

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
  roomName: string,
  metadata?: string
): Promise<void> {
  try {
    const rooms = await client.listRooms([roomName]);
    const existingRoom = rooms.find((room) => room.name === roomName);
    if (existingRoom) {
      // Update room metadata with language if room already exists
      if (metadata) {
        await client.updateRoomMetadata(roomName, metadata);
      }
      return;
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code && code !== "not_found") {
      throw err;
    }
  }

  try {
    await client.createRoom({ name: roomName, metadata });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "already_exists") {
      throw err;
    }
    // Room was just created by someone else, try updating metadata
    if (metadata) {
      try {
        await client.updateRoomMetadata(roomName, metadata);
      } catch {
        // Best effort
      }
    }
  }
}
