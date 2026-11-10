
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 5000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (req, res) => {
  res.send("AlertProof API is running.");
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "AlertProof backend is healthy."
  });
});

// --------------------------------------------------
// LANGUAGE CONFIGURATION
// --------------------------------------------------

const languages = {
  "en-IN": "English",
  "hi-IN": "Hindi",
  "bn-IN": "Bengali",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
  "mr-IN": "Marathi",
  "gu-IN": "Gujarati",
  "kn-IN": "Kannada",
  "ml-IN": "Malayalam",
  "pa-IN": "Punjabi"
};

// --------------------------------------------------
// GROQ TRANSLATION
// --------------------------------------------------

app.post("/api/translate", async (req, res) => {
  try {
    const { text, language } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        error: "Please provide text to translate."
      });
    }

    if (!languages[language]) {
      return res.status(400).json({
        success: false,
        error: "Unsupported translation language."
      });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "Groq API key is missing."
      });
    }

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b",
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content: `You are a professional emergency communication translator.

Translate the supplied emergency instruction into ${languages[language]}.

Rules:
1. Preserve all locations, numbers, times and deadlines.
2. Never omit or weaken an emergency action or warning.
3. Preserve the original urgency.
4. Do not invent additional facts.
5. Use simple, natural language that ordinary people can understand.
6. Return only the translated message.`
            },
            {
              role: "user",
              content: text
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Groq translation error:", data);

      return res.status(response.status).json({
        success: false,
        error: data.error?.message || "Translation failed."
      });
    }

    const translatedText =
      data.choices?.[0]?.message?.content?.trim();

    if (!translatedText) {
      throw new Error("Translation response was empty.");
    }

    res.json({
      success: true,
      translatedText,
      language
    });

  } catch (error) {
    console.error("Translation error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to translate the message."
    });
  }
});

// --------------------------------------------------
// EMERGENCY TRANSLATION VERIFICATION
// --------------------------------------------------

app.post("/api/verify", async (req, res) => {
  try {
    const { originalText, translatedText } = req.body;

    if (!originalText || !translatedText) {
      return res.status(400).json({
        success: false,
        error: "Both original and translated messages are required."
      });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "Groq API key is missing."
      });
    }

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b",
          temperature: 0,
          response_format: {
            type: "json_object"
          },
          messages: [
            {
              role: "system",
              content: `You are AlertProof, an emergency instruction verification system.

Compare the original emergency message with its translated version.

Check these six critical details:
1. hazard
2. location
3. requiredAction
4. urgency
5. deadline
6. destination

For every check, return:
- status: PRESERVED, CHANGED, MISSING or NOT SPECIFIED
- original: the detail from the original message
- translated: the corresponding detail in the translation
- issue: a short explanation

Rules:
- MISSING means an important detail in the original was omitted.
- CHANGED means its meaning was altered.
- NOT SPECIFIED means the original itself did not provide that detail.
- PRESERVED means the meaning is retained.
- Do not assume that an omitted detail is preserved.
- Be especially careful with locations, deadlines, evacuation actions and safety warnings.
- Set overall status to REVIEW if any important information is missing, changed or ambiguous.
- Otherwise set status to PASS.
- Human review is always required.

Return valid JSON in this structure:
{
  "status": "PASS or REVIEW",
  "summary": "Short explanation",
  "checks": {
    "hazard": {
      "status": "PRESERVED",
      "original": "",
      "translated": "",
      "issue": ""
    },
    "location": {
      "status": "PRESERVED",
      "original": "",
      "translated": "",
      "issue": ""
    },
    "requiredAction": {
      "status": "PRESERVED",
      "original": "",
      "translated": "",
      "issue": ""
    },
    "urgency": {
      "status": "PRESERVED",
      "original": "",
      "translated": "",
      "issue": ""
    },
    "deadline": {
      "status": "NOT SPECIFIED",
      "original": "",
      "translated": "",
      "issue": ""
    },
    "destination": {
      "status": "NOT SPECIFIED",
      "original": "",
      "translated": "",
      "issue": ""
    }
  },
  "issues": [],
  "humanReviewRequired": true
}`
            },
            {
              role: "user",
              content: `ORIGINAL MESSAGE:
${originalText}

TRANSLATED MESSAGE:
${translatedText}

Verify the translation.`
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Groq verification error:", data);

      return res.status(response.status).json({
        success: false,
        error: data.error?.message || "Verification failed."
      });
    }

    const result = data.choices?.[0]?.message?.content;

    if (!result) {
      throw new Error("Verification response was empty.");
    }

    const verification = JSON.parse(result);

    res.json({
      success: true,
      verification
    });

  } catch (error) {
    console.error("Verification error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to verify the translation."
    });
  }
});


// --------------------------------------------------
// LISTENER COMPREHENSION EVALUATION
// --------------------------------------------------

app.post("/api/comprehension", async (req, res) => {
  try {
    const { originalText, listenerTranscript } = req.body;

    if (!originalText?.trim() || !listenerTranscript?.trim()) {
      return res.status(400).json({
        success: false,
        error: "Original instruction and listener response are required."
      });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "Groq API key is missing."
      });
    }

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b",
          temperature: 0,
          response_format: {
            type: "json_object"
          },
          messages: [
            {
              role: "system",
              content: `You are AlertProof's emergency instruction comprehension evaluator.

Your job is to determine whether a listener understood the original emergency instruction.

You receive:
1. The original emergency instruction.
2. A speech-to-text transcript of what the listener said they understood.

Evaluate the listener's understanding, NOT the quality of a translation.

Check these six critical dimensions:
- hazard
- location
- requiredAction
- urgency
- deadline
- destination

Evaluation rules:

1. PRESERVED: The listener communicated the correct meaning. Exact wording is not required.
2. CHANGED: The listener communicated an incorrect or contradictory meaning.
3. MISSING: The original contains an important detail but the listener did not demonstrate understanding of it.
4. NOT SPECIFIED: The original instruction does not contain this detail.

Additional rules:
- Accept natural paraphrasing and equivalent expressions.
- Do not require the listener to repeat every word.
- Do not assume understanding merely because the listener says "yes" or repeats unrelated words.
- Pay special attention to evacuation directions, locations, deadlines and safety warnings.
- Do not invent details that the listener did not communicate.
- If the transcript is too unclear to judge, explain the uncertainty in the issue field and set the status to CHANGED.
- A missing critical action or incorrect location must result in REVIEW.
- PASS means all critical details specified in the original were correctly communicated by the listener.
- Human review is always required.
- This is an automated assessment, not proof of actual comprehension.

Return valid JSON in this structure:

{
  "status": "PASS or REVIEW",
  "summary": "Short explanation of the listener's demonstrated understanding",
  "checks": {
    "hazard": {
      "status": "PRESERVED",
      "original": "Expected hazard",
      "translated": "What the listener understood",
      "issue": ""
    },
    "location": {
      "status": "PRESERVED",
      "original": "Expected location",
      "translated": "What the listener understood",
      "issue": ""
    },
    "requiredAction": {
      "status": "PRESERVED",
      "original": "Expected action",
      "translated": "What the listener understood",
      "issue": ""
    },
    "urgency": {
      "status": "PRESERVED",
      "original": "Expected urgency",
      "translated": "What the listener understood",
      "issue": ""
    },
    "deadline": {
      "status": "NOT SPECIFIED",
      "original": "",
      "translated": "",
      "issue": ""
    },
    "destination": {
      "status": "NOT SPECIFIED",
      "original": "",
      "translated": "",
      "issue": ""
    }
  },
  "issues": [],
  "humanReviewRequired": true
}`
            },
            {
              role: "user",
              content: `ORIGINAL EMERGENCY INSTRUCTION:
${originalText}

LISTENER'S SPEECH TRANSCRIPT:
${listenerTranscript}

Evaluate what the listener understood.`
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Comprehension evaluation error:", data);

      return res.status(response.status).json({
        success: false,
        error: data.error?.message || "Comprehension evaluation failed."
      });
    }

    const result = data.choices?.[0]?.message?.content;

    if (!result) {
      throw new Error("Comprehension response was empty.");
    }

    const comprehension = JSON.parse(result);

    res.json({
      success: true,
      comprehension
    });

  } catch (error) {
    console.error("Comprehension error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to evaluate listener comprehension."
    });
  }
});


// --------------------------------------------------
// GNANI PRISMA SPEECH-TO-TEXT
// --------------------------------------------------

app.post(
  "/api/voice/stt",
  upload.single("audio"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "Please upload an audio recording."
        });
      }

      if (!process.env.GNANI_API_KEY) {
        return res.status(500).json({
          success: false,
          error: "Gnani API key is missing."
        });
      }

      const language = req.body.language || "hi-IN";

      if (!languages[language]) {
        return res.status(400).json({
          success: false,
          error: "Unsupported speech recognition language."
        });
      }

      const formData = new FormData();

      formData.append(
        "audio_file",
        new Blob([req.file.buffer], {
          type: req.file.mimetype || "audio/webm"
        }),
        req.file.originalname || "recording.webm"
      );

      formData.append("language_code", language);
      formData.append("preferred_language", language);
      formData.append("format", "transcribe");
      formData.append("itn_native_numerals", "true");

      const response = await fetch(
        "https://api.vachana.ai/stt/v3",
        {
          method: "POST",
          headers: {
            "X-API-Key-ID": process.env.GNANI_API_KEY
          },
          body: formData
        }
      );

      const data = await response.json();

      if (!response.ok || !data.success) {
        console.error("Gnani Prisma error:", data);

        return res.status(response.status || 500).json({
          success: false,
          error:
            data.message ||
            data.error ||
            "Prisma transcription failed."
        });
      }

      res.json({
        success: true,
        transcript: data.transcript
      });

    } catch (error) {
      console.error("Prisma STT error:", error);

      res.status(500).json({
        success: false,
        error: "Speech transcription failed."
      });
    }
  }
);

// --------------------------------------------------
// GNANI TIMBRE TEXT-TO-SPEECH
// --------------------------------------------------

app.post("/api/voice/tts", async (req, res) => {
  try {
    const {
      text,
      language = "en-IN",
      voice = "Nalini"
    } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({
        success: false,
        error: "Please provide text for voice generation."
      });
    }

    if (!process.env.GNANI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "Gnani API key is missing."
      });
    }

    const response = await fetch(
      "https://api.vachana.ai/api/v1/tts/inference",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key-ID": process.env.GNANI_API_KEY
        },
        body: JSON.stringify({
          text,
          voice,
          model: "timbre-v2.5",
          language,
          speed: 1.0,
          audio_config: {
            sample_rate: 48000,
            encoding: "linear_pcm",
            container: "wav"
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      console.error("Gnani Timbre error:", errorText);

      return res.status(response.status).json({
        success: false,
        error: "Voice generation failed."
      });
    }

    const audioBuffer = Buffer.from(
      await response.arrayBuffer()
    );

    if (
      audioBuffer.length < 44 ||
      audioBuffer.toString("ascii", 0, 4) !== "RIFF" ||
      audioBuffer.toString("ascii", 8, 12) !== "WAVE"
    ) {
      console.error("Invalid WAV response from Gnani.");

      return res.status(500).json({
        success: false,
        error: "Gnani returned an invalid audio file."
      });
    }

    res.set({
      "Content-Type": "audio/wav",
      "Content-Length": audioBuffer.length
    });

    res.send(audioBuffer);

  } catch (error) {
    console.error("TTS error:", error);

    res.status(500).json({
      success: false,
      error: "Unable to generate voice."
    });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`AlertProof server running on port ${PORT}`);
});
