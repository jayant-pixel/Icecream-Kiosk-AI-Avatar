"use client";

import { useCallback, useRef, useState } from "react";

import { transcribeAudio } from "@/lib/api";
import { AudioRecorder } from "@/lib/stt";

interface MicBarProps {
  disabled?: boolean;
  onUtterance: (text: string) => Promise<void> | void;
}

export const MicBar = ({ disabled = false, onUtterance }: MicBarProps) => {
  const [isRecording, setIsRecording] = useState(false);
  const recorderRef = useRef<AudioRecorder | null>(null);

  const handleToggleRecord = useCallback(async () => {
    if (disabled) return;

    if (isRecording) {
      try {
        if (recorderRef.current) {
          const blob = await recorderRef.current.stop();
          const transcript = await transcribeAudio(blob);
          if (transcript.trim()) {
            await onUtterance(transcript.trim());
          }
        }
      } catch (error) {
        alert("Sorry, I couldn't hear that. Please try again.");
        console.error("STT error", error);
      } finally {
        setIsRecording(false);
        recorderRef.current = null;
      }
    } else {
      recorderRef.current = new AudioRecorder();
      await recorderRef.current.start();
      setIsRecording(true);
    }
  }, [disabled, isRecording, onUtterance]);

  return (
    <div className="mic-bar">
      <button
        type="button"
        className="button button--primary"
        onClick={handleToggleRecord}
        disabled={disabled}
      >
        {isRecording ? "Stop Listening" : "Tap to Talk"}
      </button>
    </div>
  );
};
