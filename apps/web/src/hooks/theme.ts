/*
 * SPDX-FileCopyrightText: 2024 Siemens AG
 * SPDX-FileCopyrightText: 2026 CREATE contributors
 *
 * SPDX-License-Identifier: MIT
 *
 * v5 rewrite: the v4 `themeSwitcher.getCurrentTheme()` is gone. v5 splits the
 * surface into `getTheme()` (theme name, e.g. "brand") and `getMode()` /
 * `getColorSchema()` (light|dark, with mode resolving system → actual). The
 * `themeChanged` event now emits a structured payload instead of a string.
 * @siemens/ix-echarts.registerTheme registers per `<theme>-<mode>` (e.g.
 * "brand-light", "brand-dark"), so we compose the name from both pieces.
 */

import { themeSwitcher } from "@siemens/ix";
import { useLayoutEffect, useState } from "react";

function readEchartsTheme(): string {
  const theme = themeSwitcher.getTheme() ?? "brand";
  const mode = themeSwitcher.getMode();
  return `${theme}-${mode}`;
}

export const useEChartsTheme = () => {
  const [echartsTheme, setEchartsTheme] = useState<string>(readEchartsTheme);

  useLayoutEffect(() => {
    const off = themeSwitcher.themeChanged.on(() => setEchartsTheme(readEchartsTheme()));
    return off.dispose;
  }, []);

  return echartsTheme;
};
