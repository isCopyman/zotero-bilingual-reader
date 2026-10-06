import { describe, expect, it } from "vitest";
import { splitSentences } from "../../core/segment";

const split = (t: string) => splitSentences(t).map((r) => t.slice(r.start, r.end));

describe("splitSentences", () => {
  it("splits plain sentences", () => {
    expect(split("Wind power is variable. Forecasting helps operators. It matters!")).toEqual([
      "Wind power is variable.",
      "Forecasting helps operators.",
      "It matters!",
    ]);
  });
  it("keeps academic abbreviations inside sentences", () => {
    const t = "Zhang et al. proposed a model (see Fig. 2 and Eq. 3), e.g. for NWP. Results improve by 3.5% in Sec. 4.";
    expect(split(t)).toEqual([
      "Zhang et al. proposed a model (see Fig. 2 and Eq. 3), e.g. for NWP.",
      "Results improve by 3.5% in Sec. 4.",
    ]);
  });
  it("handles citations, closers and initials", () => {
    const t = 'This was shown before [12]. "A new view." J. Smith disagreed (2020). The end.';
    expect(split(t)).toEqual([
      "This was shown before [12].",
      '"A new view."',
      "J. Smith disagreed (2020).",
      "The end.",
    ]);
  });
  it("does not split before lowercase continuation", () => {
    expect(split("The value is approx. ten times larger. Next.")).toEqual(["The value is approx. ten times larger. Next."]);
  });
  it("offsets are exact and trimmed", () => {
    const t = "  First one here.   Second one here.  ";
    for (const r of splitSentences(t)) {
      expect(t.slice(r.start, r.end)).toBe(t.slice(r.start, r.end).trim());
    }
  });
});
