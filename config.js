export const PODCASTS = [
  "https://www.youtube.com/@ILTB_Podcast",
  "https://www.youtube.com/@AcquiredFM",
  // Add more RSS feed URLs or YouTube channel handles below:
  // "https://feeds.simplecast.com/54nAGcIl",    // Tim Ferriss Show
  // "https://lexfridman.com/feed/podcast/",     // Lex Fridman
];

export const FREQUENCY = "daily";   // "daily" | "weekly" | "monthly"

export const FORMAT = "bullets";    // "long" | "bullets" | "takeaways"

export const LOOKBACK_HOURS = 48;   // how far back to look for new episodes

// Only summarise the latest N episodes per podcast per run.
// Set to Infinity to process all new episodes.
export const MAX_EPISODES_PER_FEED = 1;

// Custom summarisation prompt — overrides FORMAT entirely when set.
export const CUSTOM_PROMPT = `You are an expert podcast analyst. Your task is to create a comprehensive, structured summary of the following podcast transcript.

Goals:
- Capture 100% of the important ideas, arguments, examples, and insights
- Preserve the original intent, nuance, and tone
- Avoid oversimplification — this is a high-fidelity compression, not a shallow summary

Instructions:
1. Start with a 5–7 bullet executive summary
   - The most important insights from the podcast
   - Should give a complete picture in under 1 minute of reading

2. Create a detailed structured breakdown:
   - Segment the content into logical sections/topics
   - For each section: key ideas, supporting arguments, examples/anecdotes/case studies, any data/frameworks/mental models mentioned

3. Extract all unique insights and non-obvious takeaways
   - Especially things that are novel, contrarian, or actionable

4. List all frameworks, models, and principles explicitly
   - Explain them clearly and completely

5. Capture all stories and examples in brief but complete form
   - Quote notable lines or phrases (if impactful)

6. Identify:
   - Assumptions made by the speaker
   - Implicit beliefs or worldview
   - Any biases or strong opinions

7. Actionable takeaways:
   - What should a listener do differently after this?

8. If multiple speakers are present:
   - Attribute ideas clearly to each speaker
   - Highlight agreements/disagreements

Do NOT skip "minor" details that contribute to understanding. Do not generalize away specificity. Do not add your own opinions or external knowledge.

Output Style: Clear headings, concise but information-dense, structured for readability (not a wall of text).`;
