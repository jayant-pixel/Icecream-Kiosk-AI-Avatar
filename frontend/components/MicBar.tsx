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
      try {
        const recorder = new AudioRecorder();
        recorderRef.current = recorder;
        await recorder.start();
        setIsRecording(true);
      } catch (error) {
        recorderRef.current = null;
        console.error("Recorder start error", error);
        alert("I couldn't access your microphone. Please check your permissions and try again.");
      }
    }
  }, [disabled, isRecording, onUtterance]);

  const caption = disabled
    ? "Avatar is thinking..."
    : isRecording
      ? "Listening..."
      : "Tap to talk";

  return (
    <div className="mic-control">
      <button
        type="button"
        className={`mic-control__button${isRecording ? " mic-control__button--active" : ""}`}
        onClick={handleToggleRecord}
        disabled={disabled}
        aria-pressed={isRecording}
      >
        <span className="mic-control__pulse" aria-hidden="true" />
        <span className="mic-control__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" role="img" focusable="false">
            <path
              d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.92V21h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.08A7 7 0 0 1 5 12a1 1 0 1 1 2 0 5 5 0 0 0 10 0Z"
              fill="currentColor"
            />
          </svg>
        </span>
        <span className="sr-only">{isRecording ? "Stop listening" : "Tap to talk"}</span>
      </button>
      {isRecording && (
        <button
          type="button"
          className="mic-control__stop"
          onClick={handleToggleRecord}
          disabled={disabled}
        >
          Stop listening
        </button>
      )}
      <p className="mic-control__caption">{caption}</p>
    </div>
  );
};
