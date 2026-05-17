import jsQR from "jsqr";
import QRCode from "qrcode";

/**
 * Render `text` as a QR code, returning a `data:image/png` URL ready to set on
 * an `<img src>`. Uses moderate (Q) error-correction so a small camera-capture
 * blur still scans. Margin defaults to 1 module — tight but legible.
 */
export async function renderQrPng(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: "Q",
    margin: 1,
    width: 320,
  });
}

/**
 * Pulls frames from `video` via an offscreen `<canvas>` and tries to decode a
 * QR code. Resolves with the first decoded string. Pass an `AbortSignal` to
 * cancel (e.g. when the user navigates away or cancels the scan).
 *
 * The video element should already have its stream attached and `await
 * video.play()` resolved before calling.
 */
export async function scanQrFromVideo(
  video: HTMLVideoElement,
  signal: AbortSignal,
): Promise<string> {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not allocate a 2D canvas context for QR scan");

  return new Promise<string>((resolve, reject) => {
    let stopped = false;
    const onAbort = () => {
      stopped = true;
      reject(new DOMException("QR scan aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const tick = () => {
      if (stopped) return;
      if (video.readyState !== video.HAVE_ENOUGH_DATA) {
        requestAnimationFrame(tick);
        return;
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // `inversionAttempts: "dontInvert"` skips the slower second pass — Octi
      // QRs are dark-on-light so the first pass always wins. Drop this if scans
      // start failing on weird backgrounds.
      const code = jsQR(frame.data, frame.width, frame.height, {
        inversionAttempts: "dontInvert",
      });
      if (code) {
        stopped = true;
        signal.removeEventListener("abort", onAbort);
        resolve(code.data);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Tries the rear camera first (matches the QR-scan UX user expectation on phones);
 * falls back to the default device on desktop or when the rear isn't available.
 */
export async function openCameraStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera access isn't supported by this browser");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
}
