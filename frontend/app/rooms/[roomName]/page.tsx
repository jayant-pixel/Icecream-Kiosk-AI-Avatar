import * as React from "react";
import { PageClientImpl } from "./PageClientImpl";
import { isVideoCodec } from "@/lib/types";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ roomName: string }>;
  searchParams: Promise<{
    // FIXME: We should not allow values for regions if in playground mode.
    region?: string;
    hq?: string;
    codec?: string;
  }>;
}) {
  const { roomName } = await params;
  const { region, hq, codec } = await searchParams;

  return (
    <PageClientImpl
      roomName={roomName}
      region={region}
      hq={hq === "true" ? true : false}
      codec={typeof codec === "string" && isVideoCodec(codec) ? codec : "vp9"}
    />
  );
}
