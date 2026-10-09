// Edits one asset of the open project through the undoable project store.

import { useCallback } from "react";
import { notifyError } from "@/components/notify";
import type { AssetDef } from "@/domain/model";
import { DomainError } from "@/domain/ops";
import { useProjectStore } from "@/state/projectStore";

export type AssetEdit = (label: string, recipe: (asset: AssetDef) => void, coalesceField?: string) => void;

export function useAssetEdit(uid: string): AssetEdit {
  return useCallback<AssetEdit>(
    (label, recipe, coalesceField) => {
      try {
        useProjectStore.getState().apply(
          label,
          (d) => {
            const a = d.assets.find((x) => x.uid === uid);
            if (!a) throw new DomainError("Asset not found.");
            recipe(a);
          },
          coalesceField ? { coalesceKey: `asset:${uid}:${coalesceField}` } : undefined,
        );
      } catch (e) {
        notifyError(e);
      }
    },
    [uid],
  );
}
