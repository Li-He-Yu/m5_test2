export function parseLLMJson(raw: string) {
  // 1) trim BOM/whitespace
  let s = raw.trim();

  // 2) If fenced code block, extract inner
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {s = fence[1].trim();}

  // 3) If there’s stray prose, try to grab the first JSON object
  //    (balanced-brace scan to avoid false positives)
  if (!(s.startsWith('{') || s.startsWith('['))) {
    const i = s.indexOf('{');
    if (i >= 0) {s = s.slice(i);}
  }
  // Find the matching closing brace for the first top-level JSON object
  const obj = extractFirstJsonValue(s);
  if (obj) {return JSON.parse(obj);}

  // Fallback: last attempt
  return JSON.parse(s);
}

// Helper: extract the first top-level JSON value ({...} or [...])
function extractFirstJsonValue(s: string): string | null {
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < s.length; i++) {
        const c = s[i];

        if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === quote) { inStr = false; quote = null; }
            continue;
        }

        if (c === '"' || c === "'") { inStr = true; quote = c as '"' | "'"; continue; }
        if (c === '{' || c === '[') {
            if (depth === 0) {start = i;}
            depth++;
        } else if (c === '}' || c === ']') {
            depth--;
            if (depth === 0 && start >= 0) {return s.slice(start, i + 1);}
        }
    }
    return null;
}