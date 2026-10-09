import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "@vitest/browser/context";
import { ROOT_ASSET_UID } from "@/domain/model";
import { asset, index, project } from "@/domain/__tests__/fixtures";
import { buildTreeStructure, flattenTree } from "@/features/hierarchy/tree";
import { HierarchyTree } from "../HierarchyTree";

function bigIndex() {
  const assets = [];
  for (let s = 0; s < 10; s++) {
    const site = asset(`Site ${s}`, "core.basicsite");
    assets.push(site);
    for (let i = 0; i < 1000; i++) assets.push(asset(`Asset ${s}-${i}`, "core.basicarea", { parentUid: site.uid }));
  }
  return index(project({ assets }));
}

describe("HierarchyTree", () => {
  it("renders only a window of a 10,000+ asset tree and supports keyboard navigation", async () => {
    const ix = bigIndex();
    const rows = flattenTree(buildTreeStructure(ix), { isExpanded: () => true });
    expect(rows.length).toBe(10011);
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const screen = render(
      <HierarchyTree
        rows={rows}
        index={ix}
        selectedUid={ROOT_ASSET_UID}
        query=""
        matches={new Set()}
        issuesByEntity={new Map()}
        onToggle={onToggle}
        onSelect={onSelect}
        onMove={() => undefined}
      />,
    );
    const tree = screen.container.querySelector('[role="tree"]') as HTMLElement;
    expect(tree).toBeTruthy();
    const rendered = tree.querySelectorAll('[role="treeitem"]');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(200);
    const first = rendered[0] as HTMLElement;
    expect(first.getAttribute("aria-level")).toBe("1");
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(first.getAttribute("draggable")).toBe("false");

    tree.focus();
    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() => expect(tree.getAttribute("aria-activedescendant")).toBe(`hierarchy-node-${rows[1]!.uid}`));
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(rows[1]!.uid);
    await userEvent.keyboard("{ArrowLeft}");
    expect(onToggle).toHaveBeenCalledWith(rows[1]!.uid, false);
    await userEvent.keyboard("{End}");
    await vi.waitFor(() => {
      const last = rows[rows.length - 1]!.uid;
      expect(tree.getAttribute("aria-activedescendant")).toBe(`hierarchy-node-${last}`);
      expect(tree.querySelector(`[id="hierarchy-node-${last}"]`)).toBeTruthy();
    });
  });
});
