export function validateText(text) {
  if (typeof text !== "string" || text.includes("\0") || Buffer.from(text).toString() !== text) {
    throw new Error("Plan text must be valid UTF-8 without NUL characters.");
  }
}

export function applyExactEdits(content, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("Supply at least one exact old_text/new_text edit.");
  }
  const replacements = edits.map(({ old_text: oldText, new_text: newText }) => {
    validateText(oldText);
    validateText(newText);
    if (oldText.length === 0) throw new Error("old_text must be nonempty.");
    const start = content.indexOf(oldText);
    if (start < 0 || content.indexOf(oldText, start + 1) >= 0) {
      throw new Error("old_text must match exactly once. Read the plan and include more context.");
    }
    return { start, end: start + oldText.length, text: newText };
  });
  replacements.sort((a, b) => a.start - b.start);
  let cursor = 0;
  let matched = 0;
  let result = "";
  for (const replacement of replacements) {
    if (replacement.start < cursor) throw new Error("Plan edits must not overlap.");
    result += content.slice(cursor, replacement.start) + replacement.text;
    matched += replacement.end - replacement.start;
    cursor = replacement.end;
  }
  if (matched === content.length) {
    throw new Error("Full-plan replacement is disabled. Use localized edits to the existing plan.");
  }
  return result + content.slice(cursor);
}
