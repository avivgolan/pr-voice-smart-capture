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
    playButton: document.querySelector("#play-button"),
    seek: document.querySelector("#seek-bar"),
    playClock: document.querySelector("#play-clock"),
    record: document.querySelector("#record-button"),
    liveActions: document.querySelector("#live-actions"),
    rerecord: document.querySelector("#rerecord-button"),
    review: document.querySelector("#review-panel"),
    recorderCard: document.querySelector(".recorder-card"),
    sessionError: document.querySelector("#session-error"),
    status: document.querySelector("#recording-status"),
    stop: document.querySelector("#stop-button"),
    upload: document.querySelector("#upload-button"),
    uploadError: document.querySelector("#upload-error"),
    processing: document.querySelector("#processing-panel"),
    processingTitle: document.querySelector("#processing-title"),
    processingStatus: document.querySelector("#processing-status"),
    processingProgress: document.querySelector("#processing-progress"),
    notify: document.querySelector("#notify-button"),
    leaveProcessing: document.querySelector("#leave-processing"),
    success: document.querySelector("#success-panel"),
    details: document.querySelector("#recording-details"),
    openDraft: document.querySelector("#open-draft-button"),
    returnSalesforce: document.querySelector("#return-salesforce"),
    returnSuccess: document.querySelector("#return-success-button"),
    privacyNote: document.querySelector("#privacy-note"),
  };

  let captureStream;
  let chunks = [];
  let elapsedTimer;
  let recordingStartedAt = 0;
  let recordingDuration = 0;
  let recordingBlob;
  let recorder;
  let playbackUrl;
  let userSeeked = false;
  let correctedStart = false;
  let preparingPlayback = false;
  let recordingExceededLimit = false;
  let pollTimer;
  let polling = false;
  let notifyWhenDone = false;
  let waitingForUploadPolls = 0;
  let uploadTicker;

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
    userSeeked = false;
    correctedStart = false;
    resetPlayer(0);
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
    if (job === "done") return 100;
    if (job === "extracting") return 85;
    if (job === "transcribing") return 65;
    return 50;
  }

  function setProcessing(message, value) {
    elements.processingStatus.textContent = message;
    elements.processingProgress.value = value;
    setStatus(message);
  }

  function showReturnLink(visible) {
    if (!elements.returnSalesforce || !returnUrl) return;
    elements.returnSalesforce.hidden = !visible;
  }

  function showPrivacyNote(visible) {
    if (elements.privacyNote) elements.privacyNote.hidden = !visible;
  }

  function leaveRecorder(event) {
    event.preventDefault();
    const url = event.currentTarget.getAttribute("href");
    if (!url) return;
    const destination = window.open(url, "_blank");
    if (destination) {
      try { destination.focus(); } catch { /* The new Salesforce tab is already in front. */ }
      window.close();
      return;
    }
    window.location.assign(url);
  }

  function showIdle() {
    if (elements.liveActions) elements.liveActions.hidden = false;
    if (elements.recorderCard) elements.recorderCard.hidden = false;
    elements.record.hidden = false;
    elements.record.textContent = "Start recording";
    elements.record.disabled = !validSession;
    elements.stop.hidden = true;
    elements.review.hidden = true;
    showReturnLink(true);
    showPrivacyNote(true);
  }

  function showRecording() {
    if (elements.liveActions) elements.liveActions.hidden = false;
    if (elements.recorderCard) elements.recorderCard.hidden = false;
    elements.record.hidden = true;
    elements.stop.hidden = false;
    elements.stop.disabled = false;
    elements.review.hidden = true;
    showReturnLink(true);
    showPrivacyNote(true);
  }

  function showReview() {
    if (elements.liveActions) elements.liveActions.hidden = true;
    if (elements.recorderCard) elements.recorderCard.hidden = false;
    elements.record.hidden = true;
    elements.stop.hidden = true;
    elements.review.hidden = false;
    elements.upload.disabled = false;
    elements.rerecord.disabled = false;
    showReturnLink(true);
    showPrivacyNote(true);
  }

  function showProcessing() {
    elements.review.hidden = true;
    if (elements.liveActions) elements.liveActions.hidden = true;
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
    showReturnLink(false);
    showPrivacyNote(false);
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
    showReturnLink(false);
    showPrivacyNote(false);
    setStatus("Ready to review");
    notifyFinished("Voice note ready", "Open the draft in Salesforce to review the transcript.");
  }

  function showFailed(message) {
    stopPolling();
    elements.processing.hidden = true;
    showIdle();
    showError(elements.uploadError, message || "Voice processing failed. You can record again or open Salesforce.");
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
      if (payload.processingJobId === "done") {
        setProcessing(payload.message || "Ready to review", 100);
        showReady();
        return;
      }
      if (payload.status === "Failed" || payload.processingJobId === "failed") {
        showFailed(payload.message);
        return;
      }
      if (!payload.processingJobId && (payload.status === "Processing" || payload.status === "Needs Review")) {
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
    showIdle();

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      showError(elements.sessionError, "This browser cannot record audio. Open this page in a current mobile browser.");
      setStatus("Recording unavailable");
      return;
    }

    elements.record.disabled = true;
    setStatus("Starting microphone…");

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
      showRecording();
      setStatus("Recording in progress");
    } catch (error) {
      stopTracks();
      showIdle();
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

    if (recordingExceededLimit) {
      chunks = [];
      showIdle();
      showError(elements.sessionError, "The recording exceeded the 25 MB limit. Please record a shorter note.");
      setStatus("Recording discarded");
      return;
    }

    const mimeType = recorder?.mimeType || chunks[0]?.type || "audio/webm";
    recordingBlob = new Blob(chunks, { type: mimeType });
    if (!recordingBlob.size) {
      showIdle();
      showError(elements.sessionError, "No audio was captured. Please try again.");
      setStatus("Recording unavailable");
      return;
    }

    elements.elapsed.value = formatDuration(recordingDuration);
    elements.details.textContent = `${formatDuration(recordingDuration)} recorded · ${(recordingBlob.size / 1024 / 1024).toFixed(1)} MB`;
    showReview();
    setStatus("Recording ready for review");
    attachPlayback(recordingBlob);
  }

  function patchWebmDuration(data, durationMs) {
    const limit = Math.min(data.length, 65536);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < limit - 11; i += 1) {
      if (data[i] === 0x1f && data[i + 1] === 0x43 && data[i + 2] === 0xb6 && data[i + 3] === 0x75) break;
      if (data[i] !== 0x44 || data[i + 1] !== 0x89) continue;
      if (data[i + 2] === 0x88) {
        view.setFloat64(i + 3, durationMs, false);
        return true;
      }
      if (data[i + 2] === 0x84) {
        view.setFloat32(i + 3, durationMs, false);
        return true;
      }
    }
    return false;
  }

  function knownDuration() {
    return recordingDuration || 0;
  }

  function setPlayLabel(playing) {
    if (!elements.playButton) return;
    elements.playButton.textContent = playing ? "Pause" : "Play";
    elements.playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
  }

  function resetPlayer(length) {
    userSeeked = false;
    correctedStart = false;
    if (elements.seek) {
      elements.seek.value = "0";
      elements.seek.disabled = length <= 0;
    }
    if (elements.playButton) {
      elements.playButton.disabled = length <= 0;
      setPlayLabel(false);
    }
    if (elements.playClock) {
      elements.playClock.textContent = `0:00 / ${formatDuration(length)}`;
    }
  }

  function updatePlayhead() {
    if (preparingPlayback) return;
    const length = knownDuration();
    let current = elements.playback.currentTime || 0;
    if (!correctedStart && !userSeeked && length > 1 && current > length + 0.25) {
      correctedStart = true;
      try { elements.playback.currentTime = 0; } catch { /* Seek when the browser allows it. */ }
      current = 0;
    }
    if (length && current > length) current = length;
    if (elements.seek) {
      elements.seek.value = length ? String(Math.round((current / length) * 1000)) : "0";
    }
    if (elements.playClock) {
      elements.playClock.textContent = `${formatDuration(current)} / ${formatDuration(length)}`;
    }
  }

  function preparePlayback(audio) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        try { audio.currentTime = 0; } catch { /* The file may not be seekable yet. */ }
        resolve();
      };
      const timer = window.setTimeout(done, 1200);
      const inspect = () => {
        const duration = audio.duration;
        if (Number.isFinite(duration) && duration > 0 && duration < 1e5) {
          window.clearTimeout(timer);
          done();
          return;
        }
        const onUpdate = () => {
          audio.removeEventListener("timeupdate", onUpdate);
          window.clearTimeout(timer);
          done();
        };
        audio.addEventListener("timeupdate", onUpdate);
        try {
          audio.currentTime = 1e101;
        } catch {
          window.clearTimeout(timer);
          done();
        }
      };
      if (audio.readyState >= 1) inspect();
      else {
        audio.addEventListener("loadedmetadata", inspect, { once: true });
        audio.addEventListener("error", () => {
          window.clearTimeout(timer);
          done();
        }, { once: true });
      }
    });
  }

  async function attachPlayback(blob) {
    preparingPlayback = true;
    resetPlayer(knownDuration());
    if (elements.playButton) elements.playButton.disabled = true;
    let playable = blob;
    if (String(blob.type || "").includes("webm")) {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (patchWebmDuration(bytes, Math.round(recordingDuration * 1000))) {
          playable = new Blob([bytes], { type: blob.type });
          recordingBlob = playable;
        }
      } catch {
        playable = blob;
      }
    }
    try {
      if (playbackUrl) URL.revokeObjectURL(playbackUrl);
      playbackUrl = URL.createObjectURL(playable);
      elements.playback.src = playbackUrl;
      await preparePlayback(elements.playback);
    } finally {
      preparingPlayback = false;
      resetPlayer(knownDuration());
    }
  }

  async function togglePlayback() {
    const audio = elements.playback;
    if (!audio.paused && !audio.ended) {
      audio.pause();
      return;
    }
    const length = knownDuration();
    if (audio.ended || (length && audio.currentTime > length + 0.25)) {
      try { audio.currentTime = 0; } catch { /* Seek when the browser allows it. */ }
    }
    try {
      await audio.play();
    } catch {
      setPlayLabel(false);
    }
  }

  function stopUploadTicker() {
    window.clearInterval(uploadTicker);
    uploadTicker = undefined;
  }

  function startUploadTicker() {
    stopUploadTicker();
    uploadTicker = window.setInterval(() => {
      const current = Number(elements.processingProgress.value) || 0;
      if (current >= 40) return;
      elements.processingProgress.value = current + 3;
    }, 280);
  }

  function noteUploadProgress(ratio) {
    const fromBytes = Math.max(8, Math.min(45, Math.round(ratio * 45)));
    const current = Number(elements.processingProgress.value) || 0;
    if (fromBytes > current) elements.processingProgress.value = fromBytes;
  }

  function postAudio(form) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", UPLOAD_URL);
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0) noteUploadProgress(event.loaded / event.total);
      });
      xhr.addEventListener("load", () => {
        let payload = {};
        try {
          payload = JSON.parse(xhr.responseText || "{}");
        } catch {
          payload = {};
        }
        if (xhr.status >= 200 && xhr.status < 300 && payload.ok !== false && payload.draftId) {
          resolve(payload);
          return;
        }
        reject(new Error(payload.message || "Upload was rejected"));
      });
      xhr.addEventListener("error", () => reject(new Error("Failed to fetch")));
      xhr.addEventListener("timeout", () => reject(new Error("Failed to fetch")));
      xhr.send(form);
    });
  }

  async function uploadRecording() {
    if (!recordingBlob || !validSession) return;
    clearError(elements.uploadError);
    elements.upload.disabled = true;
    elements.rerecord.disabled = true;
    showProcessing();
    if (elements.processingTitle) elements.processingTitle.textContent = "Uploading your voice note";
    setProcessing("Uploading recording…", 8);
    startUploadTicker();

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
      const payload = await postAudio(form);
      stopUploadTicker();
      clearRecording();
      if (elements.processingTitle) elements.processingTitle.textContent = "Processing your voice note";
      showProcessing();
      setProcessing(payload.message || "Transcribing your voice note", Math.max(50, progressFor(payload)));
      startPolling();
    } catch (error) {
      stopUploadTicker();
      elements.processing.hidden = true;
      showReview();
      const detail = error?.message && error.message !== "Failed to fetch" ? error.message : "Upload failed. Check your connection and try again.";
      showError(elements.uploadError, `${detail} Your recording is still available to retry.`);
      setStatus("Upload failed");
    }
  }

  function initialize() {
    if (!validSession) {
      showError(elements.sessionError, "This capture link is invalid or incomplete. Request a new link and try again.");
      setStatus("Capture link unavailable");
      return;
    }
    if (returnUrl && elements.returnSalesforce) elements.returnSalesforce.href = returnUrl;
    setStatus("Ready to record");
    showIdle();
  }

  elements.returnSalesforce?.addEventListener("click", leaveRecorder);
  elements.returnSuccess?.addEventListener("click", leaveRecorder);
  elements.leaveProcessing?.addEventListener("click", leaveRecorder);
  elements.playButton?.addEventListener("click", togglePlayback);
  elements.seek?.addEventListener("input", () => {
    userSeeked = true;
    const length = knownDuration();
    const next = (Number(elements.seek.value) / 1000) * length;
    if (elements.playClock) elements.playClock.textContent = `${formatDuration(next)} / ${formatDuration(length)}`;
    try { elements.playback.currentTime = next; } catch { /* Seek when the browser allows it. */ }
  });
  elements.playback.addEventListener("play", () => setPlayLabel(true));
  elements.playback.addEventListener("pause", () => setPlayLabel(false));
  elements.playback.addEventListener("ended", () => {
    setPlayLabel(false);
    if (elements.seek) elements.seek.value = "1000";
    if (elements.playClock) elements.playClock.textContent = `${formatDuration(knownDuration())} / ${formatDuration(knownDuration())}`;
  });
  elements.playback.addEventListener("timeupdate", () => {
    if (document.activeElement === elements.seek) return;
    updatePlayhead();
  });
  elements.record.addEventListener("click", startRecording);
  elements.stop.addEventListener("click", () => {
    if (recorder?.state === "recording") {
      setStatus("Finishing recording…");
      recorder.stop();
    }
  });
  elements.rerecord.addEventListener("click", () => {
    clearError(elements.sessionError);
    startRecording();
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
