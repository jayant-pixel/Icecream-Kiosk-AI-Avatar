const SUPPORTED_MIME_TYPES = ["audio/webm; codecs=opus", "audio/webm", "audio/mp4"];

const pickMimeType = () =>
  SUPPORTED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "audio/webm";

export class AudioRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private stopPromise: Promise<void> | null = null;

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, { mimeType });
    this.chunks = [];

    this.stopPromise = new Promise<void>((resolve, reject) => {
      if (!this.recorder) {
        return reject(new Error("Recorder not initialized"));
      }

      this.recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          this.chunks.push(event.data);
        }
      });
      this.recorder.addEventListener("stop", () => resolve());
      this.recorder.addEventListener("error", (event) => reject(event.error));
    });

    this.recorder.start();
  }

  async stop(): Promise<Blob> {
    if (!this.recorder || !this.stream) {
      throw new Error("Recording has not been started");
    }

    this.recorder.stop();
    if (this.stopPromise) {
      await this.stopPromise;
    }

    this.stream.getTracks().forEach((track) => track.stop());

    return new Blob(this.chunks, { type: this.recorder.mimeType });
  }
}

