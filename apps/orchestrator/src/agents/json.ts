export function parseJsonObject<T>(text: string): T {
  // Strip markdown fences first
  const fenced = text.trim().match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text).trim();

  // Fast path
  try {
    return JSON.parse(raw) as T;
  } catch { /* fall through */ }

  // Extract outermost {...}
  const first = raw.indexOf('{');
  if (first === -1) throw new Error(`No JSON object in model output: ${raw.slice(0, 200)}`);
  const last = raw.lastIndexOf('}');
  const candidate = last > first ? raw.slice(first, last + 1) : raw.slice(first);

  try {
    return JSON.parse(candidate) as T;
  } catch { /* fall through */ }

  // Model hit max_tokens — JSON is truncated. Recover up to the last complete
  // array element (depth-1 close), strip any trailing comma, close open brackets.
  const recovered = recoverTruncated(candidate);
  if (recovered) {
    try {
      return JSON.parse(recovered) as T;
    } catch { /* fall through */ }
  }

  throw new Error(`Failed to parse JSON from model output: ${raw.slice(0, 300)}`);
}

function recoverTruncated(s: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  let lastDepth1Close = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 1) {
        // Just closed an element that lives directly inside the root container
        lastDepth1Close = i;
      } else if (stack.length === 0) {
        // Cleanly closed the root — no truncation
        return s.slice(0, i + 1);
      }
    }
  }

  if (lastDepth1Close < 0 || stack.length === 0) return null;

  // Truncate to the last safe close, strip a trailing comma if present
  let safe = s.slice(0, lastDepth1Close + 1).trimEnd();
  if (safe.endsWith(',')) safe = safe.slice(0, -1);

  // Close all still-open brackets in reverse order
  const closes = [...stack].reverse().map(c => (c === '{' ? '}' : ']')).join('');
  return safe + closes;
}

export function parseJsonArrayPropertyItems(text: string, propertyName: string): unknown[] {
  const arrayStart = findArrayPropertyStart(text, propertyName);
  if (arrayStart === -1) return [];

  const arrayBody = sliceArrayBody(text, arrayStart);
  return extractTopLevelObjectStrings(arrayBody)
    .map(item => {
      try {
        return JSON.parse(item);
      } catch {
        return null;
      }
    })
    .filter((item): item is unknown => item !== null);
}

function findArrayPropertyStart(text: string, propertyName: string): number {
  const propertyPattern = new RegExp(`"${escapeRegExp(propertyName)}"\\s*:\\s*\\[`, 'i');
  const match = propertyPattern.exec(text);
  if (!match) return -1;
  return match.index + match[0].lastIndexOf('[');
}

function sliceArrayBody(text: string, arrayStart: number): string {
  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let i = arrayStart; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '[') depth++;
    if (char === ']') {
      depth--;
      if (depth === 0) {
        return text.slice(arrayStart + 1, i);
      }
    }
  }

  return text.slice(arrayStart + 1);
}

function extractTopLevelObjectStrings(text: string): string[] {
  const objects: string[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
