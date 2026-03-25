import { randomString } from "@/lib/client-utils";
import { ConnectionDetails } from "@/lib/types";
import {
  AccessToken,
  AccessTokenOptions,
  RoomServiceClient,
  VideoGrant,
} from "livekit-server-sdk";
import { NextRequest, NextResponse } from "next/server";

const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;

export async function GET(request: NextRequest) {
  try {
    // Parse query parameters
    const roomName = request.nextUrl.searchParams.get("roomName");
    const participantName = request.nextUrl.searchParams.get("participantName");
    const metadata = request.nextUrl.searchParams.get("metadata") ?? "";
    const language = request.nextUrl.searchParams.get("language") ?? "english";
    const region = request.nextUrl.searchParams.get("region");
    const livekitServerUrl = region ? getLiveKitURL(region) : LIVEKIT_URL;
    if (livekitServerUrl === undefined) {
      throw new Error("Invalid region");
    }

    if (typeof roomName !== "string") {
      return new NextResponse("Missing required query parameter: roomName", {
        status: 400,
      });
    }
    if (participantName === null) {
      return new NextResponse(
        "Missing required query parameter: participantName",
        { status: 400 }
      );
    }

    // Pre-create the room with language metadata BEFORE the participant joins.
    // This ensures the agent can reliably read ctx.room.metadata on connect,
    // avoiding the race condition where metadata is set after the agent reads it.
    if (API_KEY && API_SECRET && livekitServerUrl) {
      const roomMetadata = JSON.stringify({ language });
      const roomService = new RoomServiceClient(
        livekitServerUrl,
        API_KEY,
        API_SECRET
      );
      try {
        await roomService.createRoom({ name: roomName, metadata: roomMetadata });
      } catch (err) {
        // Room already exists — update its metadata instead
        try {
          await roomService.updateRoomMetadata(roomName, roomMetadata);
        } catch {
          // Best effort — request-agent will also set it as a fallback
        }
      }
    }

    // Build participant metadata with language
    const participantMetadata = metadata
      ? JSON.stringify({ ...JSON.parse(metadata), language })
      : JSON.stringify({ language });

    // Generate a fresh identity postfix per request (no cookie persistence)
    const randomParticipantPostfix = randomString(4);
    const participantToken = await createParticipantToken(
      {
        identity: `${participantName}__${randomParticipantPostfix}`,
        name: participantName,
        metadata: participantMetadata,
      },
      roomName
    );

    // Return connection details
    const data: ConnectionDetails = {
      serverUrl: livekitServerUrl,
      roomName: roomName,
      participantToken: participantToken,
      participantName: participantName,
    };

    return new NextResponse(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    if (error instanceof Error) {
      return new NextResponse(error.message, { status: 500 });
    }
  }
}

function createParticipantToken(
  userInfo: AccessTokenOptions,
  roomName: string
) {
  const at = new AccessToken(API_KEY, API_SECRET, userInfo);
  at.ttl = "30m";
  const grant: VideoGrant = {
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
  };
  at.addGrant(grant);
  return at.toJwt();
}

/**
 * Get the LiveKit server URL for the given region.
 */
function getLiveKitURL(region: string | null): string {
  let targetKey = "LIVEKIT_URL";
  if (region) {
    targetKey = `LIVEKIT_URL_${region}`.toUpperCase();
  }
  const url = process.env[targetKey];
  if (!url) {
    throw new Error(`${targetKey} is not defined`);
  }
  return url;
}
