#!/usr/bin/env bash
# lint-ix.sh — deterministic grep-based lint that catches the iX-v5
# anti-patterns from prior reviews (see ix-review-2026-06-04.md F1–F7),
# plus the Accessibility Contract rules R17–R23 (.claude/catalog-conventions.md
# §10.1, from the WCAG 2.2 AA audit of 2026-09-10).
#
# Install:
#   cp .claude/agents/ix-expert/implementer/lint-ix.sh apps/web/scripts/lint-ix.sh
#   chmod +x apps/web/scripts/lint-ix.sh
#   Add to apps/web/package.json scripts:
#     "lint:ix": "bash scripts/lint-ix.sh"
#
# Usage from apps/web:
#   pnpm lint:ix
#
# Exit code 0 = clean, 1 = at least one finding.

set -u

# Resolve target src dir — default to ./src, override with first arg.
SRC="${1:-src}"

# Collect findings without exiting early so the report shows everything.
RED=0

fail() {
  printf '  ❌  %s\n' "$1" >&2
  RED=$((RED + 1))
}

ok() {
  printf '  ✅  %s\n' "$1"
}

note() {
  printf '       %s\n' "$1" >&2
}

# ─── Deliberate exceptions ─────────────────────────────────────────────────
# Every rule below is a grep heuristic, so a rule needs a way for a variant to
# say "yes, I know, and here is why" instead of staying permanently red. Mark
# the exception in the source with the rule id and a reason — on the offending
# line itself, or on the line directly above it:
#
#   {/* lint-ix-allow R17: this variant IS the typography scale demo — it has
#       to render the optics classes without implying a document outline. */}
#   <IxTypography format="h1">Heading 1</IxTypography>
#
# A reason after the colon is mandatory — a marker with nothing readable after
# the colon is ignored, and an exception nobody can justify is not one. See
# .claude/catalog-conventions.md §10.3 for which rules may never be waived.
#
# Usage:  HITS=$(grep -rn … "$SRC" | allow_filter R17)
# Input:  lines shaped "path:lineno:…" (anything else passes through unchanged).
allow_filter() {
  perl -e '
    my $rule = shift @ARGV;
    my $pat  = qr/lint-ix-allow\s+\Q$rule\E\s*:\s*\w/;
    my %cache;
    while (my $line = <STDIN>) {
      chomp $line;
      my ($file, $no) = $line =~ /^([^:]+):(\d+):/;
      unless (defined $file && -f $file) { print "$line\n"; next; }
      unless ($cache{$file}) {
        open my $fh, "<", $file or do { print "$line\n"; next };
        my @l = <$fh>; close $fh; $cache{$file} = \@l;
      }
      my $lines = $cache{$file};
      my $here  = $lines->[$no - 1] // "";
      my $above = $no >= 2 ? ($lines->[$no - 2] // "") : "";
      next if $here =~ $pat || $above =~ $pat;
      print "$line\n";
    }
  ' "$1"
}

if [[ ! -d "$SRC" ]]; then
  echo "lint-ix: source dir not found: $SRC" >&2
  exit 2
fi

printf '\nlint:ix — iX v5 anti-pattern scan against %s\n\n' "$SRC"

# ─── R1: showMessage with unsafe cast (finding F2) ─────────────────────────
HITS=$(grep -rn 'showMessage' "$SRC" 2>/dev/null | grep -E 'as unknown|as any|as ShowMessage')
if [[ -n "$HITS" ]]; then
  fail "R1: confirmation uses showMessage with unsafe cast — use showModal() instead"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R1: no showMessage casts"
fi

# ─── R2: IxMenuSettingsItem without tabKey (finding F1) ────────────────────
# Slurps each .tsx in turn (find handles recursive glob deterministically; the
# shell's `**` is single-level unless `shopt -s globstar`).
HITS=$(find "$SRC" -type f -name '*.tsx' -print0 2>/dev/null \
       | xargs -0 perl -e '
           for my $f (@ARGV) {
             open my $fh, "<", $f or next;
             local $/; my $src = <$fh>; close $fh;
             while ($src =~ /<IxMenuSettingsItem\b([^>]*?)>/sg) {
               my $attrs = $1;
               print "$f:$attrs\n" if $attrs !~ /tabKey/;
             }
           }' 2>/dev/null)
if [[ -n "$HITS" ]]; then
  fail "R2: IxMenuSettingsItem missing tabKey (v5 requirement)"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R2: all IxMenuSettingsItem have tabKey"
fi

# ─── R3: inline style with rem/px spacing (finding F3) ─────────────────────
HITS=$(grep -rnE 'style=\{\{[^}]*("|`)[0-9]+(\.[0-9]+)?(rem|px)("|`)' "$SRC" 2>/dev/null \
       | grep -vE '/\*|//')
if [[ -n "$HITS" ]]; then
  fail "R3: inline style with hardcoded rem/px values — use CSS modules + theme tokens"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R3: no inline style with raw rem/px spacing"
fi

# ─── R4: legacy v4 idioms (finding from 90-v5-migration-reference) ─────────
LEGACY_PATTERNS='ix-validation-tooltip|disableEscapeClose|themeSwitcher\.setVariant|themeSwitcher\.setTheme|schemaChanged|data-ix-theme="classic"|theme-classic-(light|dark)|theme-brand-(light|dark)'
HITS=$(grep -rnE "$LEGACY_PATTERNS" "$SRC" 2>/dev/null)
if [[ -n "$HITS" ]]; then
  fail "R4: v4 idiom found — see 90-v5-migration-reference.md for the v5 replacement"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R4: no v4 idioms"
fi

# ─── R5: IxIconButton with legacy ghost/outline boolean (replaced by variant) ──
HITS=$(find "$SRC" -type f -name '*.tsx' -print0 2>/dev/null \
       | xargs -0 perl -e '
           for my $f (@ARGV) {
             open my $fh, "<", $f or next;
             local $/; my $src = <$fh>; close $fh;
             while ($src =~ /<IxIconButton\b([^>]*?)>/sg) {
               my $attrs = $1;
               print "$f:$attrs\n" if $attrs =~ /\b(ghost|outline)\b/ && $attrs !~ /variant=/;
             }
           }' 2>/dev/null)
if [[ -n "$HITS" ]]; then
  fail "R5: IxIconButton with legacy ghost/outline prop — use variant=\"subtle-tertiary\" etc."
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R5: no legacy ghost/outline on IxIconButton"
fi

# ─── R6: IxPane size not in allowed literal set ────────────────────────────
HITS=$(grep -rnE 'IxPane[^>]*size="[^"]+"' "$SRC" 2>/dev/null \
       | grep -vE 'size="(240px|320px|360px|480px|600px|33%|50%)"' )
if [[ -n "$HITS" ]]; then
  fail "R6: IxPane size not in allowed literals (240px|320px|360px|480px|600px|33%|50%)"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R6: IxPane size literals OK"
fi

# ─── R7: hardcoded English in src/ (finding F6+F7) ─────────────────────────
# Heuristic: a string literal containing two or more English words >=4 chars
# inside a .tsx file, outside i18n JSON. Many false positives — kept narrow.
HITS=$(grep -rnE '"\s*(Cancel|Save|Delete|Remove|Confirm|Edit|Add|Create|Close|OK|Are you sure)\s*"' "$SRC" 2>/dev/null \
       | grep -vE '"i18nKey"|defaultValue|t\(|locales/' \
       | grep -vE '/locales/')
if [[ -n "$HITS" ]]; then
  fail "R7: hardcoded English UI string — route through t() instead"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R7: no hardcoded EN UI strings (heuristic)"
fi

# ─── R8: customer-name neutrality ──────────────────────────────────────────
# Allowed: @siemens/* imports, @siemens-ix/* imports, <siemens-logo>, SPDX headers
HITS=$(grep -rn 'Siemens\|siemens' "$SRC" 2>/dev/null \
       | grep -vE '@siemens/|@siemens-ix/|siemens-ix\.css|SiemensLogo|siemens-logo|SPDX-FileCopyrightText.*Siemens')
if [[ -n "$HITS" ]]; then
  fail "R8: 'Siemens'/'siemens' outside allowed contexts (charter §6)"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R8: customer-name neutrality clean"
fi

# ─── R9: pages without light-DOM <h1> (finding F5) ─────────────────────────
# Heuristic: any *Page.tsx and pages/**/index.tsx must contain "<h1" somewhere.
# False-positive sensitive — disable if the project moves the h1 into a shared
# layout component.
MISS=""
while IFS= read -r f; do
  if ! grep -q '<h1' "$f"; then
    MISS="${MISS}${f}"$'\n'
  fi
done < <(find "$SRC" -type f \( -name '*Page.tsx' -o -path '*/pages/*/index.tsx' \) 2>/dev/null)
if [[ -n "$MISS" ]]; then
  fail "R9: page route without light-DOM <h1> (IxContentHeader's heading lives in shadow DOM)"
  echo "$MISS" | sed 's/^/       /' >&2
else
  ok "R9: every page route has <h1>"
fi

# ─── R10: data-ix-theme attribute set somewhere other than index.html ─────
# Filter out comments (// and /* */ on the same line) and string-literal references.
HITS=$(grep -rn 'data-ix-theme' "$SRC" 2>/dev/null \
       | grep -vE '\.html' \
       | grep -vE '^\s*[^:]+:[0-9]+:\s*(//|\*|#)' \
       | grep -vE '^\s*[^:]+:[0-9]+:.*//.*data-ix-theme')
if [[ -n "$HITS" ]]; then
  fail "R10: data-ix-theme set in JS/CSS — must live only in index.html"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R10: data-ix-theme lives only in index.html"
fi

# ─── R11: hex color literal in src/ (use --theme-color-* tokens) ───────────
HITS=$(grep -rnE '#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b' "$SRC" 2>/dev/null \
       | grep -vE '\.module\.css' \
       | grep -vE '#FFFFFF|#000000|#fff|#000' \
       | grep -vE '/locales/')
if [[ -n "$HITS" ]]; then
  fail "R11: hex color literal in code — use var(--theme-color-*) tokens"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R11: no stray hex colors in code"
fi

# ─── R12: forbidden non-iX UI libraries ─────────────────────────────────────
HITS=$(grep -rnE "from ['\"](tailwindcss|@mui/|@material-ui/|antd|@ant-design/|@chakra-ui/|@headlessui/react|@radix-ui/|shadcn)" "$SRC" 2>/dev/null)
if [[ -n "$HITS" ]]; then
  fail "R12: non-iX UI library imported — charter §6 forbids Material/Ant/Tailwind/Chakra/Radix/shadcn/Headless UI"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R12: no forbidden UI libraries"
fi

# ─── R13: forbidden generic libraries ───────────────────────────────────────
HITS=$(grep -rnE "from ['\"](axios|moment)['\"]" "$SRC" 2>/dev/null)
if [[ -n "$HITS" ]]; then
  fail "R13: forbidden lib (axios/moment) — use openapi-fetch / date-fns"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R13: no axios/moment imports"
fi

# ─── R14: IxEmptyState without action prop (finding F4) ─────────────────────
HITS=$(find "$SRC" -type f -name '*.tsx' -print0 2>/dev/null \
       | xargs -0 perl -e '
           for my $f (@ARGV) {
             open my $fh, "<", $f or next;
             local $/; my $src = <$fh>; close $fh;
             while ($src =~ /<IxEmptyState\b([^>]*?)(\/>|>)/sg) {
               my $attrs = $1;
               print "$f:$attrs\n" if $attrs !~ /\baction\s*=/;
             }
           }' 2>/dev/null)
if [[ -n "$HITS" ]]; then
  fail "R14: IxEmptyState without action — dead end (80-app-shell-and-dashboard.md §B8)"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R14: IxEmptyState always has an action"
fi

# ─── R16: MyCompany placeholder still in source ─────────────────────────────
# The iX starter ships Logo.tsx containing a hardcoded `<MyCompany />` SVG
# placeholder. Leaving it in is a brand-leak that has survived four builds
# (fe12-ix-direct, fe12-shadcn-first, fe13-primer-control, fe13-primer-primed).
# Replace via implementer/10-snippets/logo-replacement.tsx.
HITS=$(grep -RIn 'MyCompany\|MYCOMPANY' "$SRC" 2>/dev/null)
if [[ -n "$HITS" ]]; then
  fail "R16: MyCompany/MYCOMPANY placeholder still in source — apply logo-replacement.tsx snippet"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R16: no MyCompany placeholder leak"
fi

# ─── R15: ix-react onClick on table rows missing keyboard handler ──────────
# Heuristic: a file that has BOTH `<tr` and onClick anywhere on a tr-element
# but ZERO `onKeyDown` in the whole file is almost certainly missing a handler.
# (Multi-line opening-tag matching with arrow functions inside JSX attribute
# values is hard to do robustly with regex — this file-level check is the
# pragmatic guardrail; precision is loose, recall is good.)
HITS=$(find "$SRC" -type f -name '*.tsx' -print0 2>/dev/null \
       | xargs -0 perl -e '
           for my $f (@ARGV) {
             open my $fh, "<", $f or next;
             local $/; my $src = <$fh>; close $fh;
             # Need a <tr that has an onClick prop within the JSX block
             next unless $src =~ /<tr\b/;
             next unless $src =~ /<tr\b[^<]*?onClick=/s;
             next if $src =~ /onKeyDown=/;
             print "$f\n";
           }' 2>/dev/null)
if [[ -n "$HITS" ]]; then
  fail "R15: <tr onClick> without onKeyDown — keyboard users cannot navigate"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R15: clickable rows have keyboard handlers"
fi

# ═══ Accessibility rules R17–R23 ═══════════════════════════════════════════
# These enforce the Accessibility Contract, .claude/catalog-conventions.md
# §10.1 rules A1–A7. They live here rather than in ESLint on purpose: every
# one of them is about an *iX web component*, whose accessible behaviour is
# decided inside a shadow root that eslint-plugin-jsx-a11y cannot model. Grep
# can see the source shape, which is exactly what is wrong in each case.
# Mark deliberate exceptions with `lint-ix-allow R<nn>: <reason>` (see above).

# ─── R17: IxTypography used as a heading (conventions A1) ──────────────────
# `format="h*"` is optics only — no role, no semantics, no `as` prop. Anything
# meant as a heading must be a real heading element carrying the iX class:
#   <IxTypography format="h4">…</IxTypography>
#   → <h3 className="typography-h4">…</h3>
# The scan is tag-scoped (attribute values containing `=>` are tolerated).
HITS=$(find "$SRC" -type f -name '*.tsx' -print0 2>/dev/null \
       | xargs -0 perl -e '
           for my $f (@ARGV) {
             open my $fh, "<", $f or next;
             local $/; my $src = <$fh>; close $fh;
             while ($src =~ /<IxTypography\b((?:[^>]|=>)*?)>/sg) {
               my $attrs = $1;
               my $start = $-[0];
               next unless $attrs =~ /format\s*=\s*"h[1-6]"/;
               my $pre = substr($src, 0, $start);
               my $ln = 1 + ($pre =~ tr/\n//);
               $attrs =~ s/\s+/ /g;
               print "$f:$ln: <IxTypography$attrs>\n";
             }
           }' 2>/dev/null | allow_filter R17)
if [[ -n "$HITS" ]]; then
  fail "R17: IxTypography format=\"h*\" is optics, not a heading — use <h2..h6 className=\"typography-h*\"> (conventions A1)"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R17: no IxTypography masquerading as a heading"
fi

# ─── R18: aria-label on the text-entry family (conventions A3) ─────────────
# ix-input / ix-select / ix-textarea do NOT inherit aria-* onto the real
# control (only aria-invalid / -required / -errormessage are wired). An
# aria-label here is dead code that *looks* fixed in a diff. Use `label`.
HITS=$(find "$SRC" -type f -name '*.tsx' -print0 2>/dev/null \
       | xargs -0 perl -e '
           for my $f (@ARGV) {
             open my $fh, "<", $f or next;
             local $/; my $src = <$fh>; close $fh;
             while ($src =~ /<Ix(Input|NumberInput|Select|Textarea|DateInput|TimeInput)\b((?:[^>]|=>)*?)>/sg) {
               my ($comp, $attrs) = ($1, $2);
               my $start = $-[0];
               next unless $attrs =~ /\baria-label\s*=/;
               my $pre = substr($src, 0, $start);
               my $ln = 1 + ($pre =~ tr/\n//);
               print "$f:$ln: <Ix$comp … aria-label=…>\n";
             }
           }' 2>/dev/null | allow_filter R18)
if [[ -n "$HITS" ]]; then
  fail "R18: aria-label on Ix{Input,Select,Textarea} never reaches the control — use the label prop (conventions A3)"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R18: text-entry controls named via label prop"
fi

# ─── R23: an unnamed IxToggle (conventions A3, §10.2) ──────────────────────
# ix-toggle has NO `label` prop in iX 5.0 — the props are checked / disabled /
# indeterminate / hideText / textOn / textOff / textIndeterminate / name /
# value / required. It DOES inherit aria-label onto its role="switch" host,
# and that is the only way to name it. Without one the switch is announced as
# its own on/off caption: a control literally called "Off". R18 cannot cover
# this, because there the rule is the opposite — aria-label is the fix here,
# not the bug.
HITS=$(find "$SRC" -type f -name '*.tsx' -print0 2>/dev/null \
       | xargs -0 perl -e '
           for my $f (@ARGV) {
             open my $fh, "<", $f or next;
             local $/; my $src = <$fh>; close $fh;
             while ($src =~ /<IxToggle\b((?:[^>]|=>)*?)>/sg) {
               my $attrs = $1;
               my $start = $-[0];
               next if $attrs =~ /\baria-label(ledby)?\s*=/;
               my $pre = substr($src, 0, $start);
               my $ln = 1 + ($pre =~ tr/\n//);
               print "$f:$ln: <IxToggle …> without aria-label\n";
             }
           }' 2>/dev/null | allow_filter R23)
if [[ -n "$HITS" ]]; then
  fail "R23: IxToggle without aria-label is announced as \"Off\" — it has no label prop (conventions A3)"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R23: every IxToggle is named"
fi

# ─── R19: boolean ARIA state across the Stencil boundary (conventions A4) ──
# A React boolean arrives at the inner element as "" — an invalid ARIA value,
# silently dropped by assistive tech. The value must be a string literal:
#   aria-pressed={view === "cards"}
#   → aria-pressed={view === "cards" ? "true" : "false"}
# Accepted as already correct: a ternary that yields a quoted string, or a
# directly quoted value. Scanned in .ts/.tsx only, so prose in a README that
# quotes the anti-pattern does not go red. A string held in a variable reads as
# a finding —
# inline the ternary, or waive it with `lint-ix-allow R19`.
ARIA_STATE='aria-(pressed|expanded|checked|selected|current)'
HITS=$(grep -rnE --include='*.tsx' --include='*.ts' "$ARIA_STATE=\{" "$SRC" 2>/dev/null \
       | grep -vE "$ARIA_STATE=\{[^}]*\?[^}]*\"" \
       | grep -vE "$ARIA_STATE=\{\"" \
       | allow_filter R19)
if [[ -n "$HITS" ]]; then
  fail "R19: boolean aria-* state on an iX component — pass \"true\"/\"false\" as a string (conventions A4)"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R19: aria state attributes are strings"
fi

# ─── R20: fill token used as text colour (conventions A5) ──────────────────
# --theme-color-warning is a surface token (yellow): as text on a white card it
# measures 1.40:1 against a required 4.5:1. iX ships the text twin.
#   color: var(--theme-color-warning)  →  color: var(--theme-color-warning-text)
# Anchored so background-color / border-color do not match. Verified fine as
# text without the suffix: -success (4.71:1), -alarm (5.03:1), -primary (5.50:1).
HITS=$(grep -rnE --include='*.tsx' --include='*.ts' --include='*.css' '(^|[^-[:alnum:]])color"?\s*:\s*"?var\(--theme-color-warning\)' "$SRC" 2>/dev/null \
       | allow_filter R20)
if [[ -n "$HITS" ]]; then
  fail "R20: --theme-color-warning as text colour is 1.40:1 — use --theme-color-warning-text (conventions A5)"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R20: no fill tokens used as text colour"
fi

# ─── R21: IxIcon without a textual decision (conventions A2) ───────────────
# ix-icon always sets role="img" on itself and has no label prop, so an
# unannotated icon is an unnamed image. Every icon is either decorative
# (aria-hidden="true") or meaningful (aria-label="…"). There is no third state.
HITS=$(find "$SRC" -type f -name '*.tsx' -print0 2>/dev/null \
       | xargs -0 perl -e '
           for my $f (@ARGV) {
             open my $fh, "<", $f or next;
             local $/; my $src = <$fh>; close $fh;
             while ($src =~ /<IxIcon\b((?:[^>]|=>)*?)\/?>/sg) {
               my $attrs = $1;
               my $start = $-[0];
               next if $attrs =~ /\baria-hidden\s*=/ || $attrs =~ /\baria-label(ledby)?\s*=/;
               my $pre = substr($src, 0, $start);
               my $ln = 1 + ($pre =~ tr/\n//);
               $attrs =~ s/\s+/ /g;
               print "$f:$ln: <IxIcon$attrs>\n";
             }
           }' 2>/dev/null | allow_filter R21)
if [[ -n "$HITS" ]]; then
  fail "R21: IxIcon with neither aria-hidden nor aria-label — decide decorative vs meaningful (conventions A2)"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R21: every IxIcon is hidden or named"
fi

# ─── R22: nameless role="group" (conventions A7) ───────────────────────────
# role="group" without an accessible name adds a node to the tree that says
# nothing. Either name it (aria-label) or take the role that fits — a search
# area is role="search", not a group. Scoped to the opening tag that carries
# the role, so a label three lines away does not silently satisfy it.
HITS=$(find "$SRC" -type f -name '*.tsx' -print0 2>/dev/null \
       | xargs -0 perl -e '
           for my $f (@ARGV) {
             open my $fh, "<", $f or next;
             local $/; my $src = <$fh>; close $fh;
             while ($src =~ /<([A-Za-z][\w.-]*)((?:[^>]|=>)*?)>/sg) {
               my ($tag, $attrs) = ($1, $2);
               my $start = $-[0];
               next unless $attrs =~ /\brole\s*=\s*"group"/;
               next if $attrs =~ /\baria-label(ledby)?\s*=/;
               my $pre = substr($src, 0, $start);
               my $ln = 1 + ($pre =~ tr/\n//);
               print "$f:$ln: <$tag role=\"group\"> without a name\n";
             }
           }' 2>/dev/null | allow_filter R22)
if [[ -n "$HITS" ]]; then
  fail "R22: role=\"group\" without aria-label — name it or use the right role (conventions A7)"
  echo "$HITS" | sed 's/^/       /' >&2
else
  ok "R22: every role=\"group\" is named"
fi

echo
if [[ $RED -gt 0 ]]; then
  printf '✗ lint:ix — %d finding(s)\n' "$RED" >&2
  exit 1
fi
printf '✓ lint:ix — clean\n'
exit 0
