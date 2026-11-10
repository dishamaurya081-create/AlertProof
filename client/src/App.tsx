import { useEffect, useRef, useState } from "react";
import "./App.css";

const API =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "http://localhost:5000";

// NOTE: one voice for every language. Check that this voice actually
// supports Tamil, Telugu, etc. — if not, map a voice per language code.
const VOICE = "Nalini";
const MAX_RECORDING_SECONDS = 45;

const languages = [
  { code: "en-IN", name: "English" },
  { code: "hi-IN", name: "Hindi" },
  { code: "bn-IN", name: "Bengali" },
  { code: "ta-IN", name: "Tamil" },
  { code: "te-IN", name: "Telugu" },
  { code: "mr-IN", name: "Marathi" },
  { code: "gu-IN", name: "Gujarati" },
  { code: "kn-IN", name: "Kannada" },
  { code: "ml-IN", name: "Malayalam" },
  { code: "pa-IN", name: "Punjabi" },
];

type VerificationCheck = {
  status: string;
  original: string;
  translated: string;
  issue: string;
};

type VerificationResult = {
  status: string;
  summary: string;
  checks: Record<string, VerificationCheck>;
  issues: string[];
  humanReviewRequired: boolean;
};

const checkLabels: Record<string, string> = {
  hazard: "Hazard",
  location: "Affected location",
  requiredAction: "Required action",
  urgency: "Urgency",
  deadline: "Deadline",
  destination: "Destination",
};

/* ---------- helpers ---------- */

function statusClass(status: string) {
  if (status === "PRESERVED") return "preserved";
  if (status === "NOT SPECIFIED") return "not-specified";
  return "flagged";
}

function statusIcon(status: string) {
  if (status === "PRESERVED") return "✓";
  if (status === "NOT SPECIFIED") return "–";
  return "!";
}

function statusLabel(status: string) {
  const lower = status.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function toMessage(err: unknown, fallback: string) {
  if (err instanceof DOMException && err.name === "NotAllowedError") {
    return "Microphone access was blocked. Allow it in your browser settings, then try again.";
  }
  if (err instanceof TypeError) {
    return `Can't reach the server at ${API}. Check that the backend is running.`;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

async function postJson<T>(
  path: string,
  body: unknown,
  fallback: string
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) {
    throw new Error(data?.error || fallback);
  }
  return data as T;
}

/* ---------- report ---------- */

function VerificationReport({
  result,
  heading = "Verification report",
}: {
  result: VerificationResult;
  heading?: string;
}) {
  const passed = result.status === "PASS";

  return (
    <div className="verification-report">
      <div className="verification-heading">
        <h3>{heading}</h3>
        <span className={`chip ${passed ? "preserved" : "flagged"}`}>
          <span aria-hidden="true">{passed ? "✓" : "!"}</span>
          {passed ? "Pass" : "Review required"}
        </span>
      </div>

      <p className="report-summary">{result.summary}</p>

      <div className="checks-grid">
        {Object.entries(result.checks || {}).map(([key, check]) => (
          <div className="check-card" key={key}>
            <div className="check-card-heading">
              <strong>{checkLabels[key] || key}</strong>
              <span className={`chip ${statusClass(check.status)}`}>
                <span aria-hidden="true">{statusIcon(check.status)}</span>
                {statusLabel(check.status)}
              </span>
            </div>

            <p className="check-detail">
              <span className="check-key">Original</span>
              {check.original || "Not provided"}
            </p>

            <p className="check-detail">
              <span className="check-key">Compared text</span>
              {check.translated || "Not provided"}
            </p>

            {check.issue && <p className="issue-text">{check.issue}</p>}
          </div>
        ))}
      </div>

      {result.issues?.length > 0 && (
        <div className="issues-panel">
          <h4>Issues found</h4>
          <ul>
            {result.issues.map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {result.humanReviewRequired && (
        <div className="human-review">
          A person must review this before the instruction is used in a real
          emergency.
        </div>
      )}
    </div>
  );
}

/* ---------- app ---------- */

function App() {
  const [alertText, setAlertText] = useState("");
  const [language, setLanguage] = useState("hi-IN");

  // Snapshot of the text that was actually translated. Verification and
  // comprehension use this, so editing the box afterwards can't cause a
  // mismatch between "original" and "translated".
  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [audioUrl, setAudioUrl] = useState("");

  const [busy, setBusy] = useState<"" | "translating" | "voice">("");
  const [verifying, setVerifying] = useState(false);
  const [comprehending, setComprehending] = useState(false);

  const [verification, setVerification] = useState<VerificationResult | null>(
    null
  );

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [listenerAudioUrl, setListenerAudioUrl] = useState("");
  const [comprehensionResult, setComprehensionResult] =
    useState<VerificationResult | null>(null);

  const [error, setError] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  // Bumped whenever outputs are reset, so late responses from an
  // older request are ignored instead of overwriting newer state.
  const runRef = useRef(0);

  const languageName =
    languages.find((l) => l.code === language)?.name || language;
  const sourceChanged =
    translatedText !== "" && alertText.trim() !== sourceText;

  /* Free blob URLs when they're replaced or the app unmounts. */
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  useEffect(() => {
    return () => {
      if (listenerAudioUrl) URL.revokeObjectURL(listenerAudioUrl);
    };
  }, [listenerAudioUrl]);

  /* Release the mic if the component unmounts mid-recording. */
  useEffect(() => {
    return () => releaseStream();
  }, []);

  /* Auto-stop long recordings. */
  useEffect(() => {
    if (recording && elapsed >= MAX_RECORDING_SECONDS) stopRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, elapsed]);

  function releaseStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function resetOutputs() {
    runRef.current += 1;

    // Discard any recording in progress without transcribing it.
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.onstop = null;
      recorderRef.current.stop();
    }
    releaseStream();

    setRecording(false);
    setElapsed(0);
    setBusy("");
    setVerifying(false);
    setComprehending(false);
    setTranscribing(false);

    setSourceText("");
    setTranslatedText("");
    setAudioUrl("");
    setVerification(null);
    setTranscript("");
    setListenerAudioUrl("");
    setComprehensionResult(null);
  }

  /* ---------- translate + voice ---------- */

  async function generateVoice(text: string, run: number) {
    setBusy("voice");

    const response = await fetch(`${API}/api/voice/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language, voice: VOICE }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || "Voice generation failed.");
    }

    const blob = await response.blob();
    if (run !== runRef.current) return;
    setAudioUrl(URL.createObjectURL(blob));
  }

  async function translateAndGenerateVoice() {
    const text = alertText.trim();
    if (!text) {
      setError("Enter an emergency instruction first.");
      return;
    }

    resetOutputs();
    const run = runRef.current;
    setError("");
    setBusy("translating");

    try {
      const data = await postJson<{ translatedText: string }>(
        "/api/translate",
        { text, language },
        "Translation failed."
      );
      if (run !== runRef.current) return;

      setSourceText(text);
      setTranslatedText(data.translatedText);

      await generateVoice(data.translatedText, run);
    } catch (err) {
      if (run === runRef.current) {
        setError(toMessage(err, "Something went wrong."));
      }
    } finally {
      if (run === runRef.current) setBusy("");
    }
  }

  async function retryVoice() {
    const run = runRef.current;
    setError("");
    try {
      await generateVoice(translatedText, run);
    } catch (err) {
      if (run === runRef.current) {
        setError(toMessage(err, "Voice generation failed."));
      }
    } finally {
      if (run === runRef.current) setBusy("");
    }
  }

  /* ---------- verification ---------- */

  async function verifyTranslation() {
    if (!sourceText || !translatedText) {
      setError("Translate the message before verifying it.");
      return;
    }

    const run = runRef.current;
    setError("");
    setVerifying(true);
    setVerification(null);

    try {
      const data = await postJson<{ verification: VerificationResult }>(
        "/api/verify",
        { originalText: sourceText, translatedText },
        "Verification failed."
      );
      if (run !== runRef.current) return;
      setVerification(data.verification);
    } catch (err) {
      if (run === runRef.current) {
        setError(toMessage(err, "Verification failed."));
      }
    } finally {
      if (run === runRef.current) setVerifying(false);
    }
  }

  /* ---------- listener recording ---------- */

  async function transcribeRecording(blob: Blob, run: number) {
    setTranscribing(true);
    setError("");
    setTranscript("");
    setComprehensionResult(null);

    try {
      const formData = new FormData();
      const extension = blob.type.includes("mp4") ? "mp4" : "webm";
      formData.append("audio", blob, `listener-recording.${extension}`);
      formData.append("language", language);

      const response = await fetch(`${API}/api/voice/stt`, {
        method: "POST",
        body: formData,
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.success) {
        throw new Error(data?.error || "Speech transcription failed.");
      }
      if (!data.transcript?.trim()) {
        throw new Error("No speech was detected. Record again, closer to the microphone.");
      }
      if (run !== runRef.current) return;
      setTranscript(data.transcript);
    } catch (err) {
      if (run === runRef.current) {
        setError(toMessage(err, "Unable to transcribe audio."));
      }
    } finally {
      if (run === runRef.current) setTranscribing(false);
    }
  }

  async function startRecording() {
    try {
      setError("");
      setTranscript("");
      setComprehensionResult(null);
      setListenerAudioUrl("");

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Microphone access is unavailable. Use localhost or HTTPS."
        );
      }
      if (typeof MediaRecorder === "undefined") {
        throw new Error("This browser does not support audio recording.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      let options: MediaRecorderOptions = {};
      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        options = { mimeType: "audio/webm;codecs=opus" };
      } else if (MediaRecorder.isTypeSupported("audio/webm")) {
        options = { mimeType: "audio/webm" };
      }

      const recorder = new MediaRecorder(stream, options);
      const run = runRef.current;
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        releaseStream();
        setRecording(false);

        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });

        if (blob.size === 0) {
          setError("The recording was empty. Try again.");
          return;
        }

        setListenerAudioUrl(URL.createObjectURL(blob));
        await transcribeRecording(blob, run);
      };

      recorder.start();
      setElapsed(0);
      setRecording(true);
      timerRef.current = window.setInterval(
        () => setElapsed((seconds) => seconds + 1),
        1000
      );
    } catch (err) {
      releaseStream();
      setError(toMessage(err, "Could not start recording."));
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
  }

  async function checkComprehension() {
    if (!transcript.trim()) {
      setError("Record and transcribe a response first.");
      return;
    }

    const run = runRef.current;
    setError("");
    setComprehending(true);
    setComprehensionResult(null);

    try {
      const data = await postJson<{ comprehension: VerificationResult }>(
        "/api/comprehension",
        { originalText: sourceText, listenerTranscript: transcript },
        "Comprehension check failed."
      );
      if (run !== runRef.current) return;
      setComprehensionResult(data.comprehension);
    } catch (err) {
      if (run === runRef.current) {
        setError(toMessage(err, "Unable to check listener understanding."));
      }
    } finally {
      if (run === runRef.current) setComprehending(false);
    }
  }

  /* ---------- render ---------- */

  const working = busy !== "";

  return (
    <div className="app">
      <header>
        <h1>AlertProof</h1>
        <p>
          Check that an emergency instruction survives translation, and that
          the person hearing it understands what to do.
        </p>
      </header>

      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}

      <main>
        <section className="step">
          <span className="step-num" aria-hidden="true">1</span>
          <div className="step-body">
            <h2>
              <label htmlFor="alert-text">Source message</label>
            </h2>
            <p className="step-help">
              Paste the original official instruction, in the language it was
              written.
            </p>

            <textarea
              id="alert-text"
              className="field"
              value={alertText}
              onChange={(e) => setAlertText(e.target.value)}
              placeholder="Severe flooding expected in Sector 5. Evacuate to the school on MG Road before 6 pm."
              rows={5}
            />
          </div>
        </section>

        <section className="step">
          <span className="step-num" aria-hidden="true">2</span>
          <div className="step-body">
            <h2>
              <label htmlFor="language">Translate and generate voice</label>
            </h2>
            <p className="step-help">Pick the language the listener speaks.</p>

            <select
              id="language"
              className="field"
              value={language}
              onChange={(e) => {
                setLanguage(e.target.value);
                resetOutputs();
              }}
            >
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>

            <button
              className="btn btn-primary"
              onClick={translateAndGenerateVoice}
              disabled={working}
              aria-busy={working}
            >
              {busy === "translating"
                ? "Translating…"
                : busy === "voice"
                  ? "Generating voice…"
                  : "Translate and generate voice"}
            </button>
          </div>
        </section>

        {translatedText && (
          <section className="step">
            <span className="step-num" aria-hidden="true">3</span>
            <div className="step-body">
              <h2>{languageName} message</h2>

              <p className="translated-content" lang={language}>
                {translatedText}
              </p>

              {sourceChanged && (
                <p className="notice">
                  You edited the source message after translating. The checks
                  below still use the version that was translated. Translate
                  again to update.
                </p>
              )}

              {audioUrl ? (
                <div className="audio-section">
                  <p>Listen to the generated instruction</p>
                  <audio controls src={audioUrl}>
                    Your browser does not support audio playback.
                  </audio>
                </div>
              ) : (
                busy === "" && (
                  <button className="btn btn-secondary" onClick={retryVoice}>
                    Retry voice generation
                  </button>
                )
              )}
            </div>
          </section>
        )}

        {translatedText && (
          <section className="step">
            <span className="step-num" aria-hidden="true">4</span>
            <div className="step-body">
              <h2>Check the translation</h2>
              <p className="step-help">
                Confirm the hazard, location, action, urgency, deadline and
                destination all made it through.
              </p>

              <button
                className="btn btn-primary"
                onClick={verifyTranslation}
                disabled={verifying}
                aria-busy={verifying}
              >
                {verifying ? "Verifying…" : "Verify translation"}
              </button>

              {verification && <VerificationReport result={verification} />}
            </div>
          </section>
        )}

        {audioUrl && (
          <section className="step">
            <span className="step-num" aria-hidden="true">5</span>
            <div className="step-body">
              <h2>Check what the listener understood</h2>
              <p className="step-help">
                Play the instruction, then ask the listener to say, in{" "}
                {languageName}, what they would do. Record their answer.
              </p>

              <div className="recording-panel">
                <div className="recording-indicator" aria-live="polite">
                  <span
                    className={
                      recording ? "recording-dot active" : "recording-dot"
                    }
                    aria-hidden="true"
                  />
                  {recording
                    ? `Recording, ${elapsed}s of ${MAX_RECORDING_SECONDS}s`
                    : "Microphone ready"}
                </div>

                {!recording ? (
                  <button
                    className="btn btn-record"
                    onClick={startRecording}
                    disabled={transcribing || comprehending}
                  >
                    Start recording
                  </button>
                ) : (
                  <button className="btn btn-stop" onClick={stopRecording}>
                    Stop recording
                  </button>
                )}

                {transcribing && (
                  <p className="processing-message" role="status">
                    Transcribing the recording…
                  </p>
                )}

                {listenerAudioUrl && (
                  <div className="listener-audio">
                    <p>Recorded answer</p>
                    <audio controls src={listenerAudioUrl}>
                      Your browser does not support audio playback.
                    </audio>
                  </div>
                )}
              </div>

              {transcript && (
                <div className="transcript-panel">
                  <h3>What the listener said</h3>
                  <p lang={language}>{transcript}</p>

                  <button
                    className="btn btn-primary"
                    onClick={checkComprehension}
                    disabled={comprehending}
                    aria-busy={comprehending}
                  >
                    {comprehending ? "Checking…" : "Check understanding"}
                  </button>
                </div>
              )}

              {comprehensionResult && (
                <VerificationReport
                  result={comprehensionResult}
                  heading="Listener understanding report"
                />
              )}
            </div>
          </section>
        )}
      </main>

      <footer>
        <p>
          AlertProof is a prototype. It does not send real alerts and does not
          replace official authorities or human reviewers.
        </p>
      </footer>
    </div>
  );
}

export default App;