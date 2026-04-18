# PodDigest

Fetches new podcast episodes, summarises them with Groq's Llama 3.3, and emails a clean digest via Resend.

---

## Setup

```bash
npm install
node main.js
```

---

## Configuration (`config.js`)

| Setting | Description | Default |
|---|---|---|
| `PODCASTS` | RSS URLs or YouTube `@handles` | See file |
| `FORMAT` | `"bullets"` / `"long"` / `"takeaways"` | `"bullets"` |
| `LOOKBACK_HOURS` | How far back to look for new episodes | `48` |
| `CUSTOM_PROMPT` | Override the summarisation prompt entirely | `null` |

**Adding a podcast:**
```js
export const PODCASTS = [
  "https://www.youtube.com/@ILTB_Podcast",
  "https://feeds.simplecast.com/54nAGcIl",   // plain RSS URL
];
```

**Custom prompt example:**
```js
export const CUSTOM_PROMPT = "In 3 sentences, what would a smart investor take away from this?";
```

---

## Scheduling (8:00 AM daily)

### macOS / Linux — cron

```bash
crontab -e
# Add:
0 8 * * * node /full/path/to/Noddy/main.js >> /full/path/to/Noddy/poddigest.log 2>&1
```

Verify: `crontab -l`

### Windows — Task Scheduler

```powershell
schtasks /create /tn "PodDigest" /tr "node C:\full\path\to\Noddy\main.js" /sc daily /st 08:00
```

---

## Files

| File | Purpose |
|---|---|
| `main.js` | Main script — run this |
| `config.js` | Edit podcasts and preferences |
| `seen_episodes.txt` | Auto-managed; tracks processed GUIDs |
| `.env` | API keys (never commit) |
| `package.json` | Node.js dependencies |

---

## Reset (reprocess all episodes)

```bash
# Clear seen history
echo "" > seen_episodes.txt
```
