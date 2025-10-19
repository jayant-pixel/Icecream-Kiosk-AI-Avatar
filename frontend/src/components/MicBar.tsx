import React, { useState } from "react";
import { captureAudio } from "../lib/stt";
import { transcribeAudio } from "../lib/api";

type MicBarProps = {
  onUtterance: (text: string) => void;
};

export function MicBar({ onUtterance }: MicBarProps) {
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");

  const handleSpeak = async () => {
    try {
      setBusy(true);
      const blob = await captureAudio(3);
      const transcript = await transcribeAudio(blob);
      if (transcript) {
        onUtterance(transcript);
      }
    } catch (error) {
      console.error("STT error", error);
      alert("Audio capture failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = () => {
    if (!input.trim()) return;
    onUtterance(input.trim());
    setInput("");
  };

  return (
    <div className="mic-bar">
      <button onClick={handleSpeak} disabled={busy} className="mic-bar__button">
        {busy ? "Listening…" : "Hold to talk"}
      </button>
      <input
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            handleSubmit();
          }
        }}
        placeholder="Or type a request"
        className="mic-bar__input"
      />
      <button onClick={handleSubmit} className="mic-bar__submit">
        Send
      </button>
    </div>
  );
}
