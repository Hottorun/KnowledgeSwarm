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
