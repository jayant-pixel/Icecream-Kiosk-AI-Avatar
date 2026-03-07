import * as React from "react";
import { PageClientImpl } from "./PageClientImpl";
import { isVideoCodec } from "@/lib/types";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ roomName: string }>;
  searchParams: Promise<{
    region?: string;
    hq?: string;
    codec?: string;
    lang?: string;
  }>;
}) {
  const { roomName } = await params;
  const { region, hq, codec, lang } = await searchParams;

  return (
    <PageClientImpl
      roomName={roomName}
      region={region}
      hq={hq === "true" ? true : false}
      codec={typeof codec === "string" && isVideoCodec(codec) ? codec : "vp9"}
      language={lang === "arabic" ? "arabic" : "english"}
    />
  );
}
