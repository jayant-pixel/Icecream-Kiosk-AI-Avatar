export async function captureAudio(durationSeconds = 3): Promise<Blob> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Microphone not supported in this browser");
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
  const chunks: BlobPart[] = [];

  return await new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onerror = (event) => {
      cleanup();
      reject(event.error);
    };

    recorder.onstop = () => {
      cleanup();
      resolve(new Blob(chunks, { type: "audio/webm" }));
    };

    const cleanup = () => {
      stream.getTracks().forEach((track) => track.stop());
    };

    recorder.start();

    setTimeout(() => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }, durationSeconds * 1000);
  });
}
