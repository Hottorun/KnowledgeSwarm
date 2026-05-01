export function parseJsonObject<T>(text: string): T {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim()) as T;
    }

    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last > first) {
      return JSON.parse(trimmed.slice(first, last + 1)) as T;
    }

    throw new Error(`No JSON object found in model output: ${trimmed.slice(0, 300)}`);
  }
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
