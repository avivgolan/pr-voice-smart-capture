(() => {
  "use strict";

  const MAX_DURATION_SECONDS = 5 * 60;
  const MAX_BYTES = 25 * 1024 * 1024;
  const UPLOAD_URL = "https://n8n.mediamonster.com/webhook/voice-capture/upload";
  const MIME_CANDIDATES = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];

  const elements = {
    elapsed: document.querySelector("#elapsed-time"),
    playback: document.querySelector("#audio-playback"),
    record: document.querySelector("#record-button"),
    rerecord: document.querySelector("#rerecord-button"),
    review: document.querySelector("#review-panel"),
    sessionError: document.querySelector("#session-error"),
    status: document.querySelector("#recording-status"),
    stop: document.querySelector("#stop-button"),
    upload: document.querySelector("#upload-button"),
    uploadError: document.querySelector("#upload-error"),
    success: document.querySelector("#success-panel"),
    details: document.querySelector("#recording-details"),
  };

  let captureStream;
  let chunks = [];
  let elapsedTimer;
  let recordingStartedAt = 0;
  let recordingDuration = 0;
  let recordingBlob;
  let recorder;
  let playbackUrl;
  let recordingExceededLimit = false;

  const params = new URLSearchParams(window.location.search);
  const draftId = params.get("draftId") || "";
  const token = params.get("token") || "";

  // Salesforce record IDs are 15 or 18 alphanumeric characters. Tokens are
  // opaque, URL-safe values; accepting a bounded form avoids sending malformed input.
  const validSession = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(draftId)
    && /^[A-Za-z0-9._~-]{16,512}$/.test(token);

  function formatDuration(seconds) {
    const wholeSeconds = Math.max(0, Math.min(MAX_DURATION_SECONDS, Math.floor(seconds)));
    return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
  }

  function extensionFor(mimeType) {
    if (mimeType.includes("mp4")) return "m4a";
    if (mimeType.includes("ogg")) return "ogg";
    return "webm";
  }

  function setStatus(message) {
    elements.status.textContent = message;
  }

  function showError(element, message) {
    element.textContent = message;
    element.hidden = false;
  }

  function clearError(element) {
    element.textContent = "";
    element.hidden = true;
  }

  function stopTracks() {
    captureStream?.getTracks().forEach((track) => track.stop());
    captureStream = undefined;
  }

  function clearRecording() {
    window.clearInterval(elapsedTimer);
    chunks = [];
    recordingBlob = undefined;
    recordingDuration = 0;
    recordingExceededLimit = false;
    if (playbackUrl) URL.revokeObjectURL(playbackUrl);
    playbackUrl = undefined;
    elements.playback.removeAttribute("src");
    elements.playback.load();
    elements.review.hidden = true;
    elements.details.textContent = "";
    elements.elapsed.value = "0:00";
  }

  function updateElapsed() {
    const seconds = (performance.now() - recordingStartedAt) / 1000;
    elements.elapsed.value = formatDuration(seconds);
    if (seconds >= MAX_DURATION_SECONDS) {
      setStatus("Five-minute limit reached. Finishing recording…");
      recorder?.state === "recording" && recorder.stop();
    }
  }

  function getSupportedMimeType() {
    if (!window.MediaRecorder) return "";
    return MIME_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
  }

  async function startRecording() {
    clearError(elements.uploadError);
    clearError(elements.sessionError);
    clearRecording();

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      showError(elements.sessionError, "This browser cannot record audio. Open this page in a current mobile browser.");
      setStatus("Recording unavailable");
      return;
    }

    try {
      // Permission is requested only from this user-initiated action.
      captureStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getSupportedMimeType();
      recorder = mimeType ? new MediaRecorder(captureStream, { mimeType }) : new MediaRecorder(captureStream);
      recorder.addEventListener("dataavailable", (event) => {
        if (!event.data.size || recordingExceededLimit) return;
        const nextSize = chunks.reduce((total, chunk) => total + chunk.size, 0) + event.data.size;
        if (nextSize > MAX_BYTES) {
          recordingExceededLimit = true;
          setStatus("25 MB limit reached. Finishing recording…");
          recorder?.state === "recording" && recorder.stop();
          return;
        }
        chunks.push(event.data);
      });
      recorder.addEventListener("stop", finishRecording, { once: true });
      recorder.start(1000);
      recordingStartedAt = performance.now();
      elapsedTimer = window.setInterval(updateElapsed, 250);
      elements.record.disabled = true;
      elements.stop.disabled = false;
      setStatus("Recording in progress");
    } catch (error) {
      stopTracks();
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      showError(elements.sessionError, denied
        ? "Microphone access was not granted. Tap Allow when the browser asks for microphone access, then try again."
        : "The microphone could not be started. Check that it is available and try again.");
      setStatus("Recording unavailable");
    }
  }

  function finishRecording() {
    window.clearInterval(elapsedTimer);
    recordingDuration = Math.min(MAX_DURATION_SECONDS, (performance.now() - recordingStartedAt) / 1000);
    stopTracks();
    elements.stop.disabled = true;
    elements.record.disabled = false;

    if (recordingExceededLimit) {
      chunks = [];
      showError(elements.sessionError, "The recording exceeded the 25 MB limit. Please record a shorter note.");
      setStatus("Recording discarded");
      return;
    }

    const mimeType = recorder?.mimeType || chunks[0]?.type || "audio/webm";
    recordingBlob = new Blob(chunks, { type: mimeType });
    if (!recordingBlob.size) {
      showError(elements.sessionError, "No audio was captured. Please try again.");
      setStatus("Recording unavailable");
      return;
    }

    playbackUrl = URL.createObjectURL(recordingBlob);
    elements.playback.src = playbackUrl;
    elements.elapsed.value = formatDuration(recordingDuration);
    elements.details.textContent = `${formatDuration(recordingDuration)} recorded · ${(recordingBlob.size / 1024 / 1024).toFixed(1)} MB`;
    elements.review.hidden = false;
    setStatus("Recording ready for review");
  }

  async function uploadRecording() {
    if (!recordingBlob || !validSession) return;
    clearError(elements.uploadError);
    elements.upload.disabled = true;
    elements.rerecord.disabled = true;
    setStatus("Uploading recording…");

    const mimeType = recordingBlob.type || "audio/webm";
    const uploadBlob = recordingBlob.type ? recordingBlob : new Blob([recordingBlob], { type: mimeType });
    const filename = `voice-capture-${draftId}.${extensionFor(mimeType)}`;
    const form = new FormData();
    form.append("audio", uploadBlob, filename);
    form.append("draftId", draftId);
    form.append("token", token);
    form.append("durationSeconds", String(Math.ceil(recordingDuration)));
    form.append("filename", filename);

    try {
      const response = await fetch(UPLOAD_URL, {
        method: "POST",
        body: form,
        credentials: "omit",
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || "Upload was rejected");
      elements.review.hidden = true;
      elements.success.hidden = false;
      setStatus("Upload received");
      clearRecording();
    } catch (error) {
      const detail = error?.message && error.message !== "Failed to fetch" ? error.message : "Upload failed. Check your connection and try again.";
      showError(elements.uploadError, `${detail} Your recording is still available to retry.`);
      elements.upload.disabled = false;
      elements.rerecord.disabled = false;
      setStatus("Upload failed");
    }
  }

  function initialize() {
    if (!validSession) {
      showError(elements.sessionError, "This capture link is invalid or incomplete. Request a new link and try again.");
      setStatus("Capture link unavailable");
      return;
    }
    setStatus("Ready to record");
    elements.record.disabled = false;
  }

  elements.record.addEventListener("click", startRecording);
  elements.stop.addEventListener("click", () => {
    if (recorder?.state === "recording") {
      setStatus("Finishing recording…");
      recorder.stop();
    }
  });
  elements.rerecord.addEventListener("click", () => {
    clearError(elements.sessionError);
    clearRecording();
    setStatus("Ready to record");
    elements.record.focus();
  });
  elements.upload.addEventListener("click", uploadRecording);
  window.addEventListener("pagehide", () => {
    if (recorder?.state === "recording") recorder.stop();
    stopTracks();
    if (playbackUrl) URL.revokeObjectURL(playbackUrl);
  });

  initialize();
})();
