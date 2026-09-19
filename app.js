(() => {
  "use strict";

  const MAX_DURATION_SECONDS = 5 * 60;
  const MAX_BYTES = 25 * 1024 * 1024;
  const UPLOAD_URL = "https://n8n.mediamonster.com/webhook/voice-capture/upload";
  const STATUS_URL = "https://n8n.mediamonster.com/webhook/voice-note-status";
  const POLL_MS = 2000;
  const POLL_TIMEOUT_MS = 4 * 60 * 1000;
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
    recorderCard: document.querySelector(".recorder-card"),
    sessionError: document.querySelector("#session-error"),
    status: document.querySelector("#recording-status"),
    stop: document.querySelector("#stop-button"),
    upload: document.querySelector("#upload-button"),
    uploadError: document.querySelector("#upload-error"),
    processing: document.querySelector("#processing-panel"),
    processingStatus: document.querySelector("#processing-status"),
    processingProgress: document.querySelector("#processing-progress"),
    notify: document.querySelector("#notify-button"),
    leaveProcessing: document.querySelector("#leave-processing"),
    success: document.querySelector("#success-panel"),
    details: document.querySelector("#recording-details"),
    openDraft: document.querySelector("#open-draft-button"),
    returnSalesforce: document.querySelector("#return-salesforce"),
    returnSuccess: document.querySelector("#return-success-button"),
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
  let pollTimer;
  let polling = false;
  let notifyWhenDone = false;
  let waitingForUploadPolls = 0;

  const params = new URLSearchParams(window.location.search);
  const draftId = params.get("draftId") || "";
  const token = params.get("token") || "";
  const returnUrl = safeSalesforceUrl(params.get("returnUrl"));
  const draftUrl = safeSalesforceUrl(params.get("draftUrl"));

  const validSession = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(draftId)
    && /^[A-Za-z0-9._~-]{16,512}$/.test(token);

  function safeSalesforceUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return "";
      if (!/(^|\.)(salesforce\.com|lightning\.force\.com)$/i.test(url.hostname)) return "";
      return url.toString();
    } catch {
      return "";
    }
  }

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

  function progressFor(payload) {
    const status = String(payload?.status || "");
    const job = String(payload?.processingJobId || "");
    if (status === "Failed" || job === "failed") return 100;
    if (status === "Needs Review" || job === "done") return 100;
    if (job === "extracting") return 75;
    if (job === "transcribing") return 50;
    return 25;
  }

  function setProcessing(message, value) {
    elements.processingStatus.textContent = message;
    elements.processingProgress.value = value;
    setStatus(message);
  }

  function showProcessing() {
    elements.review.hidden = true;
    if (elements.recorderCard) elements.recorderCard.hidden = true;
    elements.processing.hidden = false;
    elements.success.hidden = true;
    if (returnUrl && elements.leaveProcessing) {
      elements.leaveProcessing.href = returnUrl;
      elements.leaveProcessing.hidden = false;
    }
    if (elements.notify && "Notification" in window) {
      elements.notify.hidden = Notification.permission === "granted";
      if (Notification.permission === "granted") notifyWhenDone = true;
    }
    if (elements.returnSalesforce) elements.returnSalesforce.hidden = true;
  }

  function notifyFinished(title, body) {
    if (!notifyWhenDone || !("Notification" in window) || Notification.permission !== "granted") return;
    try {
      new Notification(title, { body, tag: `voice-capture-${draftId}` });
    } catch {
      // Some mobile browsers grant permission but still block constructed notifications.
    }
  }

  function stopPolling() {
    polling = false;
    window.clearTimeout(pollTimer);
  }

  function showReady() {
    stopPolling();
    elements.processing.hidden = true;
    elements.success.hidden = false;
    if (draftUrl && elements.openDraft) {
      elements.openDraft.href = draftUrl;
      elements.openDraft.hidden = false;
    }
    if (returnUrl && elements.returnSuccess) {
      elements.returnSuccess.href = returnUrl;
      elements.returnSuccess.hidden = false;
    }
    setStatus("Ready to review");
    notifyFinished("Voice note ready", "Open the draft in Salesforce to review the transcript.");
  }

  function showFailed(message) {
    stopPolling();
    elements.processing.hidden = true;
    if (elements.recorderCard) elements.recorderCard.hidden = false;
    showError(elements.uploadError, message || "Voice processing failed. You can record again or open Salesforce.");
    elements.upload.disabled = false;
    elements.rerecord.disabled = false;
    setStatus("Could not process");
    notifyFinished("Voice note failed", message || "Processing failed. You can try again from the capture page.");
  }

  async function pollStatus(startedAt) {
    try {
      const url = new URL(STATUS_URL);
      url.searchParams.set("draftId", draftId);
      url.searchParams.set("token", token);
      const response = await fetch(url, { credentials: "omit", cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (payload.ok === false) {
        showFailed(payload.message || "Could not load processing status.");
        return;
      }
      if (payload.status === "Needs Review" || payload.processingJobId === "done") {
        setProcessing(payload.message || "Ready to review", 100);
        showReady();
        return;
      }
      if (payload.status === "Failed" || payload.processingJobId === "failed") {
        showFailed(payload.message);
        return;
      }
      if (!payload.processingJobId && payload.status === "Processing") {
        waitingForUploadPolls += 1;
        if (waitingForUploadPolls >= 4) {
          showFailed("The recording was not received. Please upload again.");
          return;
        }
      } else {
        waitingForUploadPolls = 0;
      }
      setProcessing(payload.message || "Processing your voice note…", progressFor(payload));
    } catch {
      setProcessing("Still working… checking again", Number(elements.processingProgress.value) || 40);
    }
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      stopPolling();
      setProcessing("Still processing. You can wait in Salesforce and open the draft when it is ready.", 90);
      return;
    }
  }

  function startPolling() {
    stopPolling();
    waitingForUploadPolls = 0;
    polling = true;
    const startedAt = Date.now();
    const tick = async () => {
      if (!polling) return;
      await pollStatus(startedAt);
      if (!polling) return;
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) return;
      pollTimer = window.setTimeout(tick, POLL_MS);
    };
    tick();
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
      if (!response.ok || payload.ok === false || !payload.draftId) {
        throw new Error(payload.message || "Upload was rejected");
      }
      clearRecording();
      showProcessing();
      setProcessing(payload.message || "Transcribing your voice note", progressFor(payload) || 50);
      startPolling();
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
    if (returnUrl && elements.returnSalesforce) {
      elements.returnSalesforce.href = returnUrl;
      elements.returnSalesforce.hidden = false;
    }
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
  elements.notify?.addEventListener("click", async () => {
    if (!("Notification" in window)) return;
    const permission = await Notification.requestPermission();
    notifyWhenDone = permission === "granted";
    elements.notify.hidden = notifyWhenDone;
    if (!notifyWhenDone) {
      showError(elements.uploadError, "Notifications were not allowed. You can still wait on this page or in Salesforce.");
    }
  });
  window.addEventListener("pagehide", () => {
    if (recorder?.state === "recording") recorder.stop();
    stopTracks();
    if (playbackUrl) URL.revokeObjectURL(playbackUrl);
  });

  initialize();
})();
