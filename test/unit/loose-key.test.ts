import { describe, expect, it } from "vitest";
import { looseKey } from "../../core/hash";

describe("looseKey: one sentence as parsed by Zotero and by MinerU", () => {
  it("ignores quotes, bullets, hyphens dropped at line ends and caption labels", () => {
    expect(looseKey("the model's initialization")).toBe(looseKey("the model’s initialization"));
    expect(looseKey("● Ensemble approaches reduce uncertainties.")).toBe(looseKey("Ensemble approaches reduce uncertainties."));
    expect(looseKey("removing high-frequency components")).toBe(looseKey("removing highfrequency components"));
    expect(looseKey("Table 1 Performance of single simulations.")).toBe(looseKey("Performance of single simulations."));
  });
  it("keeps different sentences apart and leaves sentences with LaTeX alone", () => {
    expect(looseKey("RMSE of 1.53 m/s")).not.toBe(looseKey("RMSE of 1.35 m/s"));
    expect(looseKey("where $x_t$ is the input")).toBeNull();
    expect(looseKey("Fig.")).toBeNull();
  });
});
