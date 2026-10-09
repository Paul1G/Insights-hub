import { describe, expect, it } from "vitest";
import { estimateProject } from "../estimator";
import { analyzeHealth } from "../health";
import { ROOT_ASSET_UID, type AssetDef } from "../model";
import { DEFAULT_GUARDRAILS } from "../rules";
import { validateProject } from "../validator";
import { asset, aspectType, assetType, index, project, variable } from "./fixtures";

describe("performance", () => {
  it("indexes, validates, estimates and analyses a 12,000-asset project quickly", () => {
    const metrics = aspectType("Metrics", { variables: Array.from({ length: 8 }, (_, i) => variable(`m${i}`)) });
    const pump = assetType("Pump", {
      variables: [variable("serial", { dataType: "STRING" })],
      aspects: [{ uid: "asp", name: "metrics", aspectType: { kind: "project", uid: metrics.uid } }],
    });
    const assets: AssetDef[] = [];
    // 20 sites × 20 areas × 30 pumps = 12,000 pumps (+ 420 containers)
    for (let s = 0; s < 20; s++) {
      const site = asset(`Site ${s}`, "core.basicsite", { parentUid: ROOT_ASSET_UID });
      assets.push(site);
      for (let a = 0; a < 20; a++) {
        const area = asset(`Area ${a}`, "core.basicarea", { parentUid: site.uid });
        assets.push(area);
        for (let p = 0; p < 30; p++) {
          assets.push(asset(`Pump ${p}`, pump, { parentUid: area.uid, variables: [{ name: "serial", value: `S-${s}-${a}-${p}` }] }));
        }
      }
    }
    const p = project({ aspectTypes: [metrics], assetTypes: [pump], assets });
    const t0 = performance.now();
    const ix = index(p);
    const result = validateProject(ix, DEFAULT_GUARDRAILS);
    const estimate = estimateProject(ix);
    analyzeHealth(ix, DEFAULT_GUARDRAILS);
    const elapsed = performance.now() - t0;

    expect(result.errors).toBe(0);
    expect(estimate.assets).toBe(12420);
    expect(estimate.totalAttributes).toBe(12000 * 9 + 420);
    expect(ix.levelOf(assets[assets.length - 1]!.uid)).toBe(4);
    expect(elapsed).toBeLessThan(1500);
  });
});
