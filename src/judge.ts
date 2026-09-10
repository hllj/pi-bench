// Robustly parse the LLM judge's JSON verdict. Returns parseFailed=true with a
// readable message when the output is unparseable or degenerate, so callers can
// fall back to ground truth (container test) instead of a silent default of 0.
export function parseJudgeOutput(raw: string): { score: number | null; rationale: string; parseFailed: boolean } {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    return { score: null, rationale: "Judge returned empty output", parseFailed: true };
  }
  // Strip markdown code fences (```, ```json) before parsing
  const stripped = trimmed.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();

  // Degenerate guard: nonsensical repeated-token output (e.g. "the the the ...").
  // Strip surrounding punctuation/quotes per word before dedup, so "the",
  // "the".  and the (different trailing punctuation from a broken judge
  // stream) still collapse to the same token instead of defeating the guard.
  const words = stripped.split(/\s+/).filter(Boolean).map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "").toLowerCase());
  const nonEmptyWords = words.filter(Boolean);
  if (nonEmptyWords.length >= 20) {
    const uniq = new Set(nonEmptyWords);
    if (uniq.size <= 2) {
      return {
        score: null,
        rationale: `Judge output degenerate (repeated token ${nonEmptyWords.length}x) — treated as parse failure`,
        parseFailed: true,
      };
    }
  }

  // Attempt 1: parse the full JSON object (first '{' to last '}')
  const jsonBlock = stripped.match(/\{[\s\S]*\}/);
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock[0]);
      if (typeof parsed.score === "number" && typeof parsed.rationale === "string") {
        const s = parsed.score === 1 || parsed.score === 0 ? parsed.score : (parsed.score > 0.5 ? 1 : 0);
        return { score: s, rationale: parsed.rationale, parseFailed: false };
      }
    } catch (e) { /* fall through to fallback regex */ }
  }

  // Attempt 2: salvage a score via regex, and the rationale if quoted
  const candidate = jsonBlock ? jsonBlock[0] : stripped;
  const scoreMatch = candidate.match(/"score"\s*[:：]\s*([012])\b/);
  if (scoreMatch) {
    // Same coercion as the full-JSON-parse path above, so out-of-range scores
    // (e.g. 2 from an overconfident judge) resolve identically on both paths.
    const num = parseInt(scoreMatch[1], 10);
    const s = num === 1 || num === 0 ? num : (num > 0.5 ? 1 : 0);
    const ratMatch = candidate.match(/"rationale"\s*[:：]\s*"([\s\S]*?)"\s*[,}\]]/);
    const rationale = ratMatch ? ratMatch[1] : "Judge rationale not extracted";
    return { score: s, rationale, parseFailed: false };
  }

  return { score: null, rationale: trimmed.slice(0, 400) || "Failed to parse judge output", parseFailed: true };
}
