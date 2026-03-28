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
const DEFAULT_SESSION_LIMIT_SECONDS = 15 * 60;

type RoomMetadata = {
  language?: string;
  sessionDeadlineAt?: number;
  sessionLimitSeconds?: number;
};

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
    const sessionLimitSeconds = getSessionLimitSeconds();
    let sessionDeadlineAt = Date.now() + sessionLimitSeconds * 1000;

    if (API_KEY && API_SECRET && livekitServerUrl) {
      const roomService = new RoomServiceClient(
        livekitServerUrl,
        API_KEY,
        API_SECRET
      );
      try {
        const roomMetadata = await resolveRoomMetadata(
          roomService,
          roomName,
          language,
          sessionLimitSeconds
        );
        sessionDeadlineAt = roomMetadata.sessionDeadlineAt ?? sessionDeadlineAt;
      } catch {
        // Best effort — request-agent will also preserve metadata as a fallback
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
      sessionDeadlineAt,
      sessionLimitSeconds,
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

async function resolveRoomMetadata(
  roomService: RoomServiceClient,
  roomName: string,
  language: string,
  sessionLimitSeconds: number
): Promise<RoomMetadata> {
  const rooms = await roomService.listRooms([roomName]);
  const existingRoom = rooms.find((room) => room.name === roomName);
  const existingMetadata = parseRoomMetadata(existingRoom?.metadata);
  const sessionDeadlineAt =
    existingMetadata.sessionDeadlineAt &&
    existingMetadata.sessionDeadlineAt > Date.now()
      ? existingMetadata.sessionDeadlineAt
      : Date.now() + sessionLimitSeconds * 1000;
  const nextMetadata: RoomMetadata = {
    ...existingMetadata,
    language,
    sessionLimitSeconds,
    sessionDeadlineAt,
  };
  const serializedMetadata = JSON.stringify(nextMetadata);

  if (existingRoom) {
    await roomService.updateRoomMetadata(roomName, serializedMetadata);
    return nextMetadata;
  }

  try {
    await roomService.createRoom({ name: roomName, metadata: serializedMetadata });
    return nextMetadata;
  } catch (err) {
    try {
      await roomService.updateRoomMetadata(roomName, serializedMetadata);
      return nextMetadata;
    } catch {
      throw err;
    }
  }
}

function parseRoomMetadata(raw: string | undefined): RoomMetadata {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as RoomMetadata;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function getSessionLimitSeconds(): number {
  const raw = process.env.SESSION_LIMIT_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_SESSION_LIMIT_SECONDS;
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
