import { NextResponse } from "next/server";

export async function GET() {
    const requiredEnvVars = [
        "LIVEKIT_URL",
        "LIVEKIT_API_KEY",
        "LIVEKIT_API_SECRET",
        "NEXT_PUBLIC_AGENT_NAME",
    ];

    const missing = requiredEnvVars.filter((key) => !process.env[key]);

    if (missing.length > 0) {
        return NextResponse.json(
            {
                status: "unhealthy",
                error: `Missing environment variables: ${missing.join(", ")}`,
            },
            { status: 503 }
        );
    }

    return NextResponse.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        agentName: process.env.NEXT_PUBLIC_AGENT_NAME,
        livekitUrl: process.env.LIVEKIT_URL?.replace(/wss?:\/\//, "").split(".")[0] + "...",
    });
}
