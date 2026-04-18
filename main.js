import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import RSSParser from "rss-parser";
import Groq from "groq-sdk";
import { Resend } from "resend";
import { YoutubeTranscript } from "./node_modules/youtube-transcript/dist/youtube-transcript.esm.js";
import { PODCASTS, FORMAT, LOOKBACK_HOURS, CUSTOM_PROMPT, MAX_EPISODES_PER_FEED } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEEN_FILE = path.join(__dirname, "seen_episodes.txt");
const LAST_RUN_FILE = path.join(__dirname, "last_run.txt");

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MY_EMAIL = process.env.MY_EMAIL;

const groq = new Groq({ apiKey: GROQ_API_KEY });
const resend = new Resend(RESEND_API_KEY);
const rssParser = new RSSParser({
  timeout: 20000,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; PodDigest/1.0)" },
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  const pad = level === "INFO" ? " " : "";
  console.log(`${ts}  ${level}${pad}  ${msg}`);
}

// ---------------------------------------------------------------------------
// Seen-episode tracking
// ---------------------------------------------------------------------------

function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) return new Set();
  return new Set(
    fs.readFileSync(SEEN_FILE, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
  );
}

function saveSeen(guids) {
  fs.appendFileSync(SEEN_FILE, guids.join("\n") + (guids.length ? "\n" : ""));
}

function loadLastRun() {
  if (!fs.existsSync(LAST_RUN_FILE)) return null;
  const ts = fs.readFileSync(LAST_RUN_FILE, "utf8").trim();
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

function saveLastRun() {
  fs.writeFileSync(LAST_RUN_FILE, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Feed resolution
// ---------------------------------------------------------------------------

async function resolveFeedUrl(url) {
  const ytPatterns = ["youtube.com/@", "youtube.com/c/", "youtube.com/user/", "youtube.com/channel/"];
  if (ytPatterns.some((p) => url.includes(p))) {
    return resolveYouTube(url);
  }
  return url;
}

async function resolveYouTube(url) {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PodDigest/1.0)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    const m1 = html.match(/https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=([A-Za-z0-9_-]+)/);
    if (m1) {
      const feed = `https://www.youtube.com/feeds/videos.xml?channel_id=${m1[1]}`;
      log("INFO", `  Resolved YouTube feed: ${feed}`);
      return feed;
    }

    const m2 = html.match(/"channelId"\s*:\s*"([A-Za-z0-9_-]+)"/);
    if (m2) {
      const feed = `https://www.youtube.com/feeds/videos.xml?channel_id=${m2[1]}`;
      log("INFO", `  Resolved YouTube feed (method 2): ${feed}`);
      return feed;
    }

    const m3 = html.match(/"externalId"\s*:\s*"([A-Za-z0-9_-]+)"/);
    if (m3) {
      const feed = `https://www.youtube.com/feeds/videos.xml?channel_id=${m3[1]}`;
      log("INFO", `  Resolved YouTube feed (method 3): ${feed}`);
      return feed;
    }

    log("ERROR", `Could not extract channel ID from ${url}`);
    return null;
  } catch (err) {
    log("ERROR", `Failed to resolve YouTube URL ${url}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Feed fetching
// ---------------------------------------------------------------------------

async function fetchEpisodes(feedUrl, label, seen, cutoff) {
  try {
    const feed = await rssParser.parseURL(feedUrl);
    const podcastName = feed.title || label;
    const isYouTube = feedUrl.includes("youtube.com/feeds");

    const episodes = [];
    for (const item of feed.items || []) {
      const guid = item.guid || item.link || "";
      if (!guid || seen.has(guid)) continue;

      const pubDate = item.pubDate ? new Date(item.pubDate) : null;
      if (pubDate && pubDate < cutoff) continue;

      const audioUrl = item.enclosure?.url || item.link || "";

      episodes.push({
        guid,
        title: item.title || "Untitled",
        description: item.contentSnippet || item.content || item.summary || "",
        audioUrl,
        pubDate: item.pubDate || "",
        podcastName,
        link: item.link || audioUrl,
        isYouTube,
      });
    }

    return episodes;
  } catch (err) {
    log("ERROR", `Failed to fetch feed ${feedUrl}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Transcript fetching
// ---------------------------------------------------------------------------

function isYouTubeVideoUrl(url) {
  return /youtube\.com\/(watch|shorts\/)|youtu\.be\//.test(url);
}

function extractYouTubeVideoId(url) {
  // watch?v=ID
  const watchMatch = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];
  // youtu.be/ID
  const shortMatch = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];
  // youtube.com/shorts/ID
  const shortsMatch = url.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/);
  if (shortsMatch) return shortsMatch[1];
  return null;
}

async function fetchYouTubeTranscript(videoUrl) {
  const videoId = extractYouTubeVideoId(videoUrl);
  if (!videoId) throw new Error(`Cannot extract video ID from: ${videoUrl}`);
  const segments = await YoutubeTranscript.fetchTranscript(videoId);
  return segments
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function transcribeAudioUrl(audioUrl) {
  log("INFO", `  Downloading audio for Whisper transcription…`);
  const resp = await fetch(audioUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PodDigest/1.0)" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching audio`);

  // Read up to 24 MB to stay under Groq's 25 MB limit
  const MAX_BYTES = 24 * 1024 * 1024;
  const chunks = [];
  let total = 0;
  for await (const chunk of resp.body) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= MAX_BYTES) break;
  }

  const buffer = Buffer.concat(chunks);
  log("INFO", `  Audio downloaded: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

  const ext = (audioUrl.match(/\.(mp3|m4a|wav|ogg|webm)/i) || ["", "mp3"])[1];
  const file = new File([buffer], `audio.${ext}`, { type: `audio/${ext}` });

  const result = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3",
    response_format: "text",
  });

  const text = typeof result === "string" ? result : result.text;
  log("INFO", `  Transcription complete: ${text.length.toLocaleString()} chars`);
  return text;
}

async function getFullTranscript(episode) {
  // YouTube: fetch auto-generated captions
  if (episode.isYouTube && isYouTubeVideoUrl(episode.link)) {
    try {
      const text = await fetchYouTubeTranscript(episode.link);
      if (text.length > 200) {
        log("INFO", `  Transcript: ${text.length.toLocaleString()} chars (YouTube captions)`);
        return text;
      }
      log("WARN", "  YouTube captions too short or empty");
    } catch (err) {
      log("WARN", `  YouTube captions unavailable: ${err.message}`);
    }
  }

  // Regular podcast: transcribe audio via Groq Whisper
  const audioUrl = episode.audioUrl;
  if (audioUrl && /\.(mp3|m4a|wav|ogg|webm)/i.test(audioUrl)) {
    try {
      return await transcribeAudioUrl(audioUrl);
    } catch (err) {
      log("WARN", `  Audio transcription failed: ${err.message}`);
    }
  }

  // Fall back to RSS description
  log("WARN", `  No transcript available — using episode description`);
  return null;
}

// ---------------------------------------------------------------------------
// Summarisation
// ---------------------------------------------------------------------------

const PROMPTS = {
  long: "Write a detailed 3-4 paragraph summary covering main topics, key arguments, and actionable insights.",
  bullets: "Summarize in exactly 5 bullet points, each capturing one distinct insight. Start each bullet with •",
  takeaways: "Extract the single most important takeaway in 1-2 sentences. Be direct and specific.",
};

// Two-tier model strategy:
//   Chunk summaries  → llama-3.1-8b-instant  (500k TPD free tier, fast)
//   Final synthesis  → llama-3.3-70b-versatile (100k TPD, used once per episode)
// 15s delay between chunk calls keeps us under the 6k TPM limit on the free tier.
const CHUNK_MODEL = "llama-3.1-8b-instant";
const SYNTHESIS_MODEL = "llama-3.3-70b-versatile";
const CHUNK_SIZE = 8_000;        // chars per chunk ≈ 2,000 tokens
const CHUNK_DELAY_MS = 15_000;   // delay between Groq calls

function stripHtml(text) {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function groqChat(model, messages, maxTokens = 1024) {
  const response = await groq.chat.completions.create({
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.3,
  });
  return response.choices[0].message.content.trim();
}

async function summariseChunk(episode, chunkText, chunkIndex, totalChunks) {
  return groqChat(CHUNK_MODEL, [
    {
      role: "system",
      content:
        "You are a podcast analyst. Summarise the following transcript segment in 250–350 words. " +
        "Capture every key idea, argument, example, data point, and quote. Be dense and specific — no filler.",
    },
    {
      role: "user",
      content:
        `Podcast: ${episode.podcastName}\nEpisode: ${episode.title}\n` +
        `Segment ${chunkIndex + 1} of ${totalChunks}:\n\n${chunkText}`,
    },
  ], 512);
}

async function synthesiseFinal(episode, chunkSummaries) {
  const combined = chunkSummaries
    .map((s, i) => `## Segment ${i + 1}\n${s}`)
    .join("\n\n");

  const prompt = CUSTOM_PROMPT || PROMPTS[FORMAT] || PROMPTS.bullets;
  return groqChat(SYNTHESIS_MODEL, [
    {
      role: "system",
      content: `${prompt}\n\nDo not add preamble — output the structured summary directly.`,
    },
    {
      role: "user",
      content:
        `Podcast: ${episode.podcastName}\nEpisode: ${episode.title}\n\n` +
        `Below are summaries of each transcript segment. Synthesise them into the final output:\n\n${combined}`,
    },
  ], 4096);
}

async function summarise(episode) {
  let source = await getFullTranscript(episode);
  if (!source) source = stripHtml(episode.description);
  if (!source.trim()) return "No content available.";

  // Short enough for a single request — send directly
  if (source.length <= CHUNK_SIZE) {
    const prompt = CUSTOM_PROMPT || PROMPTS[FORMAT] || PROMPTS.bullets;
    try {
      return await groqChat(SYNTHESIS_MODEL, [
        {
          role: "system",
          content: `${prompt}\n\nDo not add preamble — output the structured summary directly.`,
        },
        {
          role: "user",
          content: `Podcast: ${episode.podcastName}\nEpisode: ${episode.title}\n\nTRANSCRIPT:\n${source}`,
        },
      ], 4096);
    } catch (err) {
      log("ERROR", `Summarisation failed for "${episode.title}": ${err.message}`);
      return source.slice(0, 500);
    }
  }

  // Long transcript: chunk → summarise each → synthesise
  const chunks = [];
  for (let i = 0; i < source.length; i += CHUNK_SIZE) {
    chunks.push(source.slice(i, i + CHUNK_SIZE));
  }
  log("INFO", `  Chunking into ${chunks.length} segments (${CHUNK_DELAY_MS / 1000}s apart)…`);

  const chunkSummaries = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const s = await summariseChunk(episode, chunks[i], i, chunks.length);
      chunkSummaries.push(s);
      log("INFO", `  Segment ${i + 1}/${chunks.length} done`);
    } catch (err) {
      log("WARN", `  Segment ${i + 1} failed (${err.message}) — skipping`);
    }
    if (i < chunks.length - 1) await sleep(CHUNK_DELAY_MS);
  }

  if (chunkSummaries.length === 0) return source.slice(0, 500);

  log("INFO", `  Synthesising final summary…`);
  await sleep(CHUNK_DELAY_MS);
  try {
    return await synthesiseFinal(episode, chunkSummaries);
  } catch (err) {
    log("ERROR", `Synthesis failed: ${err.message}`);
    return chunkSummaries.join("\n\n---\n\n");
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function episodeBlock(ep) {
  // Convert markdown-style formatting to HTML for the email
  const summaryHtml = ep.summary
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^#{1,3} (.+)$/gm, "<strong>$1</strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");

  return `
    <div style="margin-bottom:40px;padding-bottom:36px;border-bottom:1px solid #e5e7eb;">
      <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;
                  letter-spacing:0.08em;margin-bottom:6px;">${ep.podcastName}</div>
      <h2 style="margin:0 0 4px;font-size:18px;line-height:1.3;color:#111827;">${ep.title}</h2>
      <div style="font-size:12px;color:#9ca3af;margin-bottom:16px;">${ep.pubDate}</div>
      <div style="font-size:14px;color:#374151;line-height:1.75;">${summaryHtml}</div>
      <a href="${ep.link}"
         style="display:inline-block;margin-top:16px;font-size:13px;color:#3b82f6;
                text-decoration:none;font-weight:500;">Listen →</a>
    </div>`;
}

function buildHtml(episodes) {
  const dateStr = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
  const count = episodes.length;
  const blocks = episodes.map(episodeBlock).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>PodDigest</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;">
  <div style="max-width:680px;margin:32px auto;padding:0 16px;">
    <div style="background:#111827;border-radius:12px 12px 0 0;padding:28px 32px;">
      <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:-0.02em;">PodDigest</div>
      <div style="margin-top:4px;font-size:13px;color:#9ca3af;">
        ${dateStr} &nbsp;·&nbsp; ${count} new episode${count !== 1 ? "s" : ""}
      </div>
    </div>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:32px 32px 8px;">
      ${blocks}
      <div style="padding:16px 0 24px;font-size:12px;color:#d1d5db;text-align:center;">
        PodDigest &nbsp;·&nbsp; Full transcripts summarised by Groq llama-3.3-70b
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function sendDigest(episodes) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const html = buildHtml(episodes);

  const result = await resend.emails.send({
    from: "PodDigest <onboarding@resend.dev>",
    to: [MY_EMAIL],
    subject: `PodDigest — ${dateStr}`,
    html,
  });

  if (result.error) throw new Error(JSON.stringify(result.error));
  log("INFO", `Email sent — id: ${result.data?.id}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("INFO", "=".repeat(55));
  log("INFO", "PodDigest starting");
  log("INFO", `Format: ${FORMAT}  |  Lookback: ${LOOKBACK_HOURS}h  |  Feeds: ${PODCASTS.length}`);
  log("INFO", "=".repeat(55));

  const seen = loadSeen();
  const lastRun = loadLastRun();
  const cutoff = lastRun
    ? lastRun
    : new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  log("INFO", lastRun
    ? `Cutoff: last run at ${lastRun.toISOString()}`
    : `Cutoff: first run — looking back ${LOOKBACK_HOURS}h`);

  const allEpisodes = [];
  const newGuids = [];

  for (const rawUrl of PODCASTS) {
    const url = rawUrl.trim();
    if (!url || url.startsWith("//")) continue;

    log("INFO", `Processing: ${url}`);
    const feedUrl = await resolveFeedUrl(url);
    if (!feedUrl) {
      log("WARN", "  Skipping — could not resolve feed URL");
      continue;
    }

    const label = url.split("/").pop().replace(/^@/, "");
    const allNew = await fetchEpisodes(feedUrl, label, seen, cutoff);
    const episodes = allNew.slice(0, MAX_EPISODES_PER_FEED);
    log("INFO", `  ${allNew.length} new episode(s) found, processing latest ${episodes.length}`);

    for (const ep of episodes) {
      log("INFO", `  Summarising: ${ep.title.slice(0, 70)}`);
      ep.summary = await summarise(ep);
      allEpisodes.push(ep);
      newGuids.push(ep.guid);
    }
  }

  log("INFO", "-".repeat(55));

  if (allEpisodes.length === 0) {
    log("INFO", "No new episodes found — nothing to send.");
    saveLastRun();
    return;
  }

  log("INFO", `Sending digest: ${allEpisodes.length} episode(s) → ${MY_EMAIL}`);
  await sendDigest(allEpisodes);
  saveSeen(newGuids);
  saveLastRun();
  log("INFO", `Done — ${newGuids.length} GUIDs saved to seen_episodes.txt`);
}

main().catch((err) => {
  log("ERROR", err.stack || err.message);
  process.exit(1);
});
