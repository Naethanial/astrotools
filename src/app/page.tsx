"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create, all, type MathJsStatic } from "mathjs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  ArrowRight,
  CornerDownLeft,
  Delete,
} from "lucide-react";

import constantsData from "../../constants/constants.json";
import formulasData from "../../constants/Formulas.json";

const MathQuillField = dynamic(
  () =>
    import("@/components/mathquill-field").then((m) => m.MathQuillField),
  { ssr: false }
);

const StaticMathField = dynamic(
  () => import("react-mathquill").then((m) => m.StaticMathField),
  { ssr: false }
);

const math = create(all, {}) as unknown as MathJsStatic;

type Line = {
  latex: string;
  text: string;
};

type ConstantDef = {
  key: string;
  label: string;
  value: number;
};

type FormulaTreeItem =
  | { text: string; next: string; value?: never }
  | { text: string; value: string; next?: never };

type FormulaTree = Record<string, FormulaTreeItem[]>;

type MQFieldApi = {
  focus: () => void;
  write: (latex: string) => void;
  keystroke?: (keys: string) => void;
  latex: () => string;
  text: () => string;
};

const FUNCTION_NAMES = [
  // Internal function used for constant embeds:
  //   \embed{const}[...] -> __const("...")
  // Must be treated as a function name so we don't insert implicit multiplication:
  //   __const("k")  (NOT __const*("k"))
  "__const",
  "asin",
  "acos",
  "atan",
  "asinh",
  "acosh",
  "atanh",
  "sinh",
  "cosh",
  "tanh",
  "sin",
  "cos",
  "tan",
  "sec",
  "csc",
  "cot",
  "sqrt",
  "sum",
  "prod",
  "int",
  "ln",
  "log",
  "log10",
  "log2",
  "exp",
  "abs",
  "floor",
  "ceil",
  "round",
  "mod",
  "gcd",
  "lcm",
  "factorial",
  "combinations",
  "permutations",
];

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripWhitespaceOutsideStrings(s: string) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (/\s/.test(ch)) continue;
    out += ch;
  }
  return out;
}

function isValidConstEmbedKey(key: string) {
  const k = String(key);
  if (!k.trim()) return false;
  // MathQuill embed ids are serialized inside `[...]`; disallow `]` to avoid breaking.
  if (k.includes("]")) return false;
  if (k.includes("\n") || k.includes("\r")) return false;
  return true;
}

function insertImplicitFunctionCalls(expr: string) {
  // Allow calculator-style function calls without parentheses:
  //   sin1  -> sin(1)
  //   cosx  -> cos(x)
  //   sqrt9 -> sqrt(9)
  //
  // This intentionally only grabs the *next token* as the argument (number/const/id).
  const sortedFns = [...FUNCTION_NAMES].sort((a, b) => b.length - a.length);
  const fnAlt = sortedFns.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const arg =
    "(?:-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?|pi|e|tau|phi|i|[a-zA-Z_]\\w*)";
  const re = new RegExp(`\\b(${fnAlt})(?!\\()(${arg})`, "g");

  let out = expr;
  while (true) {
    const next = out.replace(re, (_m, fn, a) => `${fn}(${a})`);
    if (next === out) break;
    out = next;
  }
  return out;
}

function insertImplicitMultiplication(expr: string) {
  // Make common calculator-style inputs mathjs-friendly:
  // - 2(3) => 2*(3)
  // - (2)3 => (2)*3
  // - 2pi => 2*pi
  // - 2sin(3) => 2*sin(3)
  // - x(y) => x*(y)
  // - 2x => 2*x
  let out = expr;

  const functionNames = new Set(FUNCTION_NAMES);

  // Between number/constant/')' and '('
  out = out.replace(/(\d|\)|pi|e|tau|phi|i)(?=\()/g, "$1*");
  // Between ')' and number/constant/identifier
  out = out.replace(/(\))(?=(\d|pi|e|tau|phi|i|[a-zA-Z_]))/g, "$1*");
  // Between number/constant and identifier
  // Use word boundaries for single-letter constants so we don't split inside names
  // like "sin", "sec", or "ceil".
  out = out.replace(
    /(\d|\)|\bpi\b|\be\b|\btau\b|\bphi\b|\bi\b)(?=[a-zA-Z_])/g,
    "$1*"
  );
  // Identifier followed by '(' (variable * (...) ), but not for functions.
  out = out.replace(/([a-zA-Z_]\w*)(?=\()/g, (name) =>
    functionNames.has(name) ? name : `${name}*`
  );

  return out;
}

function latexToExpression(latex: string) {
  let expr = latex;
  expr = expr.replace(/\\left\(/g, "(").replace(/\\right\)/g, ")");
  expr = expr.replace(/\\left\[/g, "(").replace(/\\right\]/g, ")");

  // Balanced group parsing for LaTeX commands that take braced arguments.
  // We can't reliably do this with regex because expressions like 10^{35}
  // introduce nested braces inside a \frac{...}{...}.
  const parseBraceGroup = (s: string, start: number) => {
    if (s[start] !== "{") return null;
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth === 0) {
        return { content: s.slice(start + 1, i), end: i + 1 };
      }
    }
    return null;
  };

  const parseBracketGroup = (s: string, start: number) => {
    if (s[start] !== "[") return null;
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
      if (depth === 0) {
        return { content: s.slice(start + 1, i), end: i + 1 };
      }
    }
    return null;
  };

  const replaceAllFrac = (s: string) => {
    let out = s;
    let idx = out.indexOf("\\frac");
    while (idx !== -1) {
      let pos = idx + "\\frac".length;

      // MathQuill commonly emits both:
      // - \frac{a}{b}
      // - \frac ab  (aka \frac12 / \frac32)  <-- no braces for single-token args
      // Support both forms.
      // Parse a single fraction argument token.
      // Important: for shorthand \frac12 / \frac32, MathQuill means "1 over 2",
      // not "12 over <missing>" — so we must consume ONE "atom" per arg.
      const parseFracArg = (str: string, start: number) => {
        let i = start;
        while (i < str.length && /\s/.test(str[i]!)) i++;
        const ch = str[i];
        if (!ch) return null;
        if (ch === "{") return parseBraceGroup(str, i);
        // Single LaTeX command token like \pi, \theta, etc.
        if (ch === "\\") {
          let j = i + 1;
          while (j < str.length && /[a-zA-Z]/.test(str[j]!)) j++;
          if (j === i + 1) return null;
          return { content: str.slice(i, j), end: j };
        }
        // Otherwise, consume exactly one character ("atom") for shorthand \fracab.
        return { content: ch, end: i + 1 };
      };

      const num = parseFracArg(out, pos);
      if (!num) {
        idx = out.indexOf("\\frac", idx + 1);
        continue;
      }
      pos = num.end;
      const den = parseFracArg(out, pos);
      if (!den) {
        idx = out.indexOf("\\frac", idx + 1);
        continue;
      }
      const replacement = `((${num.content})/(${den.content}))`;
      out = out.slice(0, idx) + replacement + out.slice(den.end);
      // Re-scan starting at the replacement location so we also catch nested \frac
      // occurrences that were inside the original numerator/denominator.
      idx = out.indexOf("\\frac", idx);
    }
    return out;
  };

  const replaceAllSqrt = (s: string) => {
    let out = s;
    let idx = out.indexOf("\\sqrt");
    while (idx !== -1) {
      let pos = idx + "\\sqrt".length;
      let root: { content: string; end: number } | null = null;
      if (out[pos] === "[") {
        root = parseBracketGroup(out, pos);
        if (!root) {
          idx = out.indexOf("\\sqrt", idx + 1);
          continue;
        }
        pos = root.end;
      }
      const inner = parseBraceGroup(out, pos);
      if (!inner) {
        idx = out.indexOf("\\sqrt", idx + 1);
        continue;
      }
      const replacement = root
        ? `((${inner.content})^(1/(${root.content})))`
        : `sqrt(${inner.content})`;
      out = out.slice(0, idx) + replacement + out.slice(inner.end);
      idx = out.indexOf("\\sqrt", idx + replacement.length);
    }
    return out;
  };

  expr = replaceAllFrac(expr);
  expr = replaceAllSqrt(expr);

  // Convert common MathQuill LaTeX to mathjs-friendly text.
  const replaceLoop = (
    pattern: RegExp,
    replacer: (...args: unknown[]) => string
  ) => {
    let prev;
    do {
      prev = expr;
      expr = expr.replace(pattern, (...args) => replacer(...args));
    } while (expr !== prev);
  };

  // (Fractions and roots handled above using balanced-group parsing.)
  // Absolute value |x|
  replaceLoop(/\\left\|([^|{}]+)\\right\|/g, (_m, inner) => {
    return `abs(${inner})`;
  });
  // Floor/ceil brackets.
  replaceLoop(/\\left\\lfloor([^{}]+)\\right\\rfloor/g, (_m, inner) => {
    return `floor(${inner})`;
  });
  replaceLoop(/\\left\\lceil([^{}]+)\\right\\rceil/g, (_m, inner) => {
    return `ceil(${inner})`;
  });

  // Convert operatorname wrappers (e.g., \\operatorname{gcd}).
  replaceLoop(/\\operatorname\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_m, name) => {
    return String(name);
  });

  // Convert MathQuill embeds used for constants:
  //   \embed{const}[speed of light]  => __const("speed of light")
  replaceLoop(/\\embed\{const\}\[([^\]]+)\]/g, (_m, id) => {
    const key = String(id);
    // Use a function call so typed identifiers don't magically become constants.
    // Keep it a string so we can support keys with spaces and punctuation.
    return `__const(${JSON.stringify(key)})`;
  });

  expr = expr
    .replace(/\\times/g, "*")
    .replace(/\\div/g, "/")
    .replace(/\\cdot/g, "*")
    .replace(/\\pi/g, "pi")
    .replace(/\\tau/g, "tau")
    .replace(/\\phi/g, "phi")
    .replace(/\\theta/g, "theta")
    .replace(/\\ln/g, "ln")
    .replace(/\\log/g, "log")
    .replace(/\\sin/g, "sin")
    .replace(/\\cos/g, "cos")
    .replace(/\\tan/g, "tan")
    .replace(/\\sec/g, "sec")
    .replace(/\\csc/g, "csc")
    .replace(/\\cot/g, "cot")
    .replace(/\\arcsin/g, "asin")
    .replace(/\\arccos/g, "acos")
    .replace(/\\arctan/g, "atan")
    .replace(/\\sinh/g, "sinh")
    .replace(/\\cosh/g, "cosh")
    .replace(/\\tanh/g, "tanh")
    .replace(/\\exp/g, "exp")
    // Allow simple function forms for sum/prod/int.
    .replace(/\\sum/g, "sum")
    .replace(/\\prod/g, "prod")
    .replace(/\\int/g, "int")
    // Preserve string literal contents (used by __const("...")).
    ;

  // Powers like:
  // - x^{2}
  // - (x+1)^{1/2}
  // - (pi*5)^{\frac{1}{2}}
  // Avoid regex here because bases are often parenthesized expressions and can
  // contain operators like `*` (e.g. `(pi*5)`), which would break a simple match.
  const replaceAllPowers = (s: string) => {
    let out = s;
    let i = 0;

    const isIdentChar = (ch: string) => /[0-9a-zA-Z._]/.test(ch);

    const findMatchingOpen = (
      str: string,
      closeIdx: number,
      openCh: string,
      closeCh: string
    ) => {
      let depth = 0;
      for (let j = closeIdx; j >= 0; j--) {
        const ch = str[j];
        if (ch === closeCh) depth++;
        else if (ch === openCh) depth--;
        if (depth === 0) return j;
      }
      return -1;
    };

    while (i < out.length) {
      const caret = out.indexOf("^{", i);
      if (caret === -1) break;

      // Parse the braced exponent group (starts at "{").
      const powerGroup = parseBraceGroup(out, caret + 1);
      if (!powerGroup) {
        i = caret + 2;
        continue;
      }

      const baseEnd = caret; // exclusive
      if (baseEnd <= 0) {
        i = powerGroup.end;
        continue;
      }

      let baseStart = baseEnd - 1;
      const last = out[baseStart];

      if (last === ")") {
        const openIdx = findMatchingOpen(out, baseStart, "(", ")");
        if (openIdx === -1) {
          i = powerGroup.end;
          continue;
        }
        baseStart = openIdx;
      } else if (last === "]") {
        const openIdx = findMatchingOpen(out, baseStart, "[", "]");
        if (openIdx === -1) {
          i = powerGroup.end;
          continue;
        }
        baseStart = openIdx;
      } else if (last === "}") {
        const openIdx = findMatchingOpen(out, baseStart, "{", "}");
        if (openIdx === -1) {
          i = powerGroup.end;
          continue;
        }
        baseStart = openIdx;
      } else {
        // Grab a contiguous identifier/number token.
        while (baseStart - 1 >= 0 && isIdentChar(out[baseStart - 1])) {
          baseStart--;
        }
      }

      const base = out.slice(baseStart, baseEnd);
      const power = powerGroup.content;
      const replacement = `(${base})^(${power})`;
      out = out.slice(0, baseStart) + replacement + out.slice(powerGroup.end);
      i = baseStart + replacement.length;
    }

    return out;
  };

  expr = replaceAllPowers(expr);

  // Strip remaining braces.
  expr = expr.replace(/[{}]/g, "");
  const finalExpr = stripWhitespaceOutsideStrings(expr);

  return finalExpr;
}

function normalizeExpression(text: string) {
  let out = stripWhitespaceOutsideStrings(text)
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/π/g, "pi");

  // TI-style infix combinations/permutations.
  out = out.replace(
    /([0-9a-zA-Z._()]+)nCr([0-9a-zA-Z._()]+)/g,
    "combinations($1,$2)"
  );
  out = out.replace(
    /([0-9a-zA-Z._()]+)nPr([0-9a-zA-Z._()]+)/g,
    "permutations($1,$2)"
  );

  return out;
}

function toMathExpression(latex: string, text: string) {
  // Prefer LaTeX (most reliable), but fall back to MathQuill text.
  const base = latex ? latexToExpression(latex) : normalizeExpression(text);
  const normalized = normalizeExpression(base);
  const withFnCalls = insertImplicitFunctionCalls(normalized);
  const finalExpr = insertImplicitMultiplication(withFnCalls);

  return finalExpr;
}

function normalizeNumber(n: number) {
  if (!Number.isFinite(n)) return n;
  const eps = 1e-12;
  if (Math.abs(n) < eps) return 0;
  const r = Math.round(n);
  if (Math.abs(n - r) < eps) return r;
  // Reduce visible floating-point noise.
  return Number(math.format(n, { precision: 14 }));
}

function formatNumberForDisplay(n: number): string {
  if (!Number.isFinite(n)) {
    if (Number.isNaN(n)) return "\\text{NaN}";
    return n > 0 ? "\\infty" : "-\\infty";
  }

  // For zero
  if (n === 0) return "0";

  const absN = Math.abs(n);
  
  // Use scientific notation for very large (>= 10 billion) or very small (< 0.0001) numbers
  const TEN_BILLION = 1e10;
  const SMALL_THRESHOLD = 1e-4;
  
  if (absN >= TEN_BILLION || absN < SMALL_THRESHOLD) {
    // Scientific notation: X.XXXXXXXX × 10^Y
    const exponent = Math.floor(Math.log10(absN));
    const mantissa = n / Math.pow(10, exponent);
    
    // Format mantissa preserving significant digits, remove trailing zeros
    const mantissaStr = mantissa.toPrecision(9).replace(/\.?0+$/, "");
    
    return `${mantissaStr} \\times 10^{${exponent}}`;
  }

  // For "normal" sized numbers, format with commas
  // Check if it's effectively an integer
  if (Number.isInteger(n) || Math.abs(n - Math.round(n)) < 1e-9) {
    const intVal = Math.round(n);
    return intVal.toLocaleString("en-US");
  }
  // For decimals, format with up to 9 sig figs
  const formatted = n.toPrecision(9);
  const parsed = parseFloat(formatted);
  // If the parsed value is a clean integer, use commas
  if (Number.isInteger(parsed)) {
    return parsed.toLocaleString("en-US");
  }
  // Otherwise split into integer and decimal parts
  const parts = parsed.toString().split(".");
  const intPart = parseInt(parts[0], 10).toLocaleString("en-US");
  const decPart = parts[1] ? `.${parts[1]}` : "";
  return `${intPart}${decPart}`;
}

function resultToLatex(result: unknown) {
  try {
    // Handle numbers specially for nice formatting
    if (typeof result === "number") {
      return formatNumberForDisplay(result);
    }
    // mathjs exposes `latex(...)` at runtime, but its TS types may not include it.
    return (math as unknown as { latex: (x: unknown) => string }).latex(result);
  } catch {
    if (typeof result === "string") return `\\text{${result}}`;
    return String(result);
  }
}

function evaluateLines(
  lines: Line[],
  angleUnit: "deg" | "rad",
  constantsMap: Record<string, number>
): Array<{ latex: string; raw: unknown }> {
  const scope: Record<string, unknown> = {};
  // TI-style logs and last answer variable.
  scope.ln = (x: number) => math.log(x);
  scope.log = (x: number, base?: number) =>
    base == null ? math.log10(x) : math.log(x, base);

  // Simple numeric integral helper: int(f, a, b[, n])
  // Example: int(x^2, 0, 1)  -> ~0.3333
  scope.int = (
    f: unknown,
    a: number,
    b: number,
    n = 1000
  ): number => {
    const fn =
      typeof f === "function"
        ? (f as (x: number) => number)
        : (x: number) => math.evaluate(String(f), { x });
    const steps = Math.max(10, Math.floor(n));
    const h = (b - a) / steps;
    let acc = 0.5 * (fn(a) + fn(b));
    for (let i = 1; i < steps; i++) {
      acc += fn(a + i * h);
    }
    return acc * h;
  };
  if (angleUnit === "deg") {
    scope.sin = (x: number) => math.sin(math.unit(x, "deg"));
    scope.cos = (x: number) => math.cos(math.unit(x, "deg"));
    scope.tan = (x: number) => math.tan(math.unit(x, "deg"));
    scope.sec = (x: number) => 1 / (scope.cos as (x: number) => number)(x);
    scope.csc = (x: number) => 1 / (scope.sin as (x: number) => number)(x);
    scope.cot = (x: number) => 1 / (scope.tan as (x: number) => number)(x);
    scope.asin = (x: number) => Number(math.asin(x)) * (180 / Math.PI);
    scope.acos = (x: number) => Number(math.acos(x)) * (180 / Math.PI);
    scope.atan = (x: number) => Number(math.atan(x)) * (180 / Math.PI);
  }

  // Badge-only constants: only \embed{const}[...] inserts compile to __const("...").
  scope.__const = (name: unknown) => {
    const k = String(name);
    if (!(k in constantsMap)) throw new Error("Unknown constant");
    return constantsMap[k];
  };

  const out: Array<{ latex: string; raw: unknown }> = [];
  let lastAns: unknown = 0;
  for (const line of lines) {
    const expr = line.text;
    if (!expr) {
      out.push({ latex: "", raw: "" });
      continue;
    }
    try {
      scope.ans = lastAns;
      scope.Ans = lastAns;

      let res = math.evaluate(expr, scope);
      // If the user enters a bare function name (e.g. `sin`),
      // mathjs returns a function object. Rendering it is noisy and can
      // blow up layout. Keep the result blank until it's a valid value.
      if (typeof res === "function") {
        out.push({ latex: "", raw: "" });
        continue;
      }
      if (typeof res === "number") res = normalizeNumber(res);
      if (res !== undefined) lastAns = res;
      out.push({ latex: resultToLatex(res), raw: res });
    } catch (err) {
      // Keep the result blank for invalid/incomplete inputs.
      out.push({ latex: "", raw: "" });
    }
  }
  return out;
}

function expressionToLatexWithConstEmbeds(
  value: string,
  constantsMap: Record<string, number>
): string {
  const constKeys = Object.keys(constantsMap)
    .filter((k) => isValidConstEmbedKey(k))
    // Replace longer keys first so we don't partially consume multi-word constants.
    .sort((a, b) => b.length - a.length);

  const tokenToKey = new Map<string, string>();
  let tokenIdx = 0;
  let expr = String(value);

  // Replace bracket placeholders like [radius] -> radius (for mathjs parsing).
  expr = expr.replace(/\[([^\]]+)\]/g, (_m, inner) => {
    const id = String(inner).trim().replace(/\s+/g, "_");
    return id ? id : "x";
  });

  for (const key of constKeys) {
    const token = `CONST${tokenIdx++}`;
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(key)}(?![A-Za-z0-9_])`, "g");
    const next = expr.replace(re, token);
    if (next !== expr) {
      tokenToKey.set(token, key);
      expr = next;
    }
  }

  try {
    const node = math.parse(expr);
    let latex = node.toTex({ parenthesis: "keep" });
    for (const [token, key] of tokenToKey.entries()) {
      // mathjs may or may not wrap symbols with \mathrm{...}; handle both.
      const re1 = new RegExp(`\\\\mathrm\\{${escapeRegExp(token)}\\}`, "g");
      const re2 = new RegExp(`\\b${escapeRegExp(token)}\\b`, "g");
      latex = latex.replace(re1, `\\embed{const}[${key}]`).replace(re2, `\\embed{const}[${key}]`);
    }
    return latex;
  } catch {
    // Fallback: if parsing fails, insert a minimally-sanitized expression.
    // We still swap in const embeds so evaluation works.
    let out = expr;
    for (const [token, key] of tokenToKey.entries()) {
      const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, "g");
      out = out.replace(re, `\\embed{const}[${key}]`);
    }
    return out;
  }
}

export default function Home() {
  const UNDO_STORAGE_KEY = "calculator:undo:v1";
  const MAX_UNDO_SNAPSHOTS = 150;

  const [lines, setLines] = useState<Line[]>([{ latex: "", text: "" }]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [angleUnit, setAngleUnit] = useState<"deg" | "rad">("rad");
  const fieldRefs = useRef<Array<MQFieldApi | null>>([]);
  const [formulasOpen, setFormulasOpen] = useState(false);
  const [constantsOpen, setConstantsOpen] = useState(false);
  const [calcCentered, setCalcCentered] = useState(true);
  const [calcAnchor, setCalcAnchor] = useState<"left" | "right">("left");

  // Combined flag for blur/fade styling when either drawer is open
  const drawerOpen = formulasOpen || constantsOpen;

  type UndoSnapshot = { lines: Line[]; activeIndex: number };
  const undoRef = useRef<{
    stack: UndoSnapshot[];
    index: number;
    lastSig: string | null;
    restoring: boolean;
    commitTimer: number | null;
  }>({ stack: [], index: 0, lastSig: null, restoring: false, commitTimer: null });
  const linesRef = useRef(lines);
  const activeIndexRef = useRef(activeIndex);

  const cloneSnapshot = useCallback((snap: UndoSnapshot): UndoSnapshot => {
    return {
      activeIndex: snap.activeIndex,
      lines: snap.lines.map((l) => ({ latex: l.latex, text: l.text })),
    };
  }, []);

  const snapshotSignature = useCallback((snap: UndoSnapshot) => {
    // Small data; stringify is fine and gives stable comparisons.
    return JSON.stringify(snap);
  }, []);

  const persistUndo = useCallback(() => {
    try {
      const u = undoRef.current;
      const payload = { v: 1, stack: u.stack, index: u.index };
      window.localStorage.setItem(UNDO_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }, [UNDO_STORAGE_KEY]);

  const applySnapshot = useCallback(
    (snap: UndoSnapshot) => {
      const safeIndex = Math.max(0, Math.min(snap.activeIndex, snap.lines.length - 1));
      undoRef.current.restoring = true;
      // Reset refs array so we don't focus stale MathQuill instances after undo.
      fieldRefs.current = new Array(snap.lines.length).fill(null);
      setLines(cloneSnapshot(snap).lines);
      setActiveIndex(safeIndex);
      requestAnimationFrame(() => {
        fieldRefs.current[safeIndex]?.focus?.();
      });
      // Allow subsequent state changes to be recorded again.
      requestAnimationFrame(() => {
        undoRef.current.restoring = false;
      });
    },
    [cloneSnapshot, fieldRefs]
  );

  const pushUndoSnapshot = useCallback(
    (snap: UndoSnapshot) => {
      const u = undoRef.current;
      if (u.restoring) return;
      const sig = snapshotSignature(snap);
      if (sig === u.lastSig) return;

      // Drop any "redo" branch if we had undone (even though we only expose undo).
      if (u.index < u.stack.length - 1) {
        u.stack = u.stack.slice(0, u.index + 1);
      }

      u.stack.push(cloneSnapshot(snap));
      u.index = u.stack.length - 1;
      u.lastSig = sig;

      if (u.stack.length > MAX_UNDO_SNAPSHOTS) {
        const overflow = u.stack.length - MAX_UNDO_SNAPSHOTS;
        u.stack.splice(0, overflow);
        u.index = Math.max(0, u.index - overflow);
      }

      persistUndo();
    },
    [MAX_UNDO_SNAPSHOTS, cloneSnapshot, persistUndo, snapshotSignature]
  );

  const commitUndoNow = useCallback(() => {
    if (typeof window === "undefined") return;
    const snap: UndoSnapshot = { lines: linesRef.current, activeIndex: activeIndexRef.current };
    pushUndoSnapshot(snap);
  }, [pushUndoSnapshot]);

  const scheduleUndoCommit = useCallback(() => {
    if (typeof window === "undefined") return;
    const u = undoRef.current;
    if (u.restoring) return;
    if (u.commitTimer) window.clearTimeout(u.commitTimer);
    u.commitTimer = window.setTimeout(() => {
      u.commitTimer = null;
      commitUndoNow();
    }, 250) as unknown as number;
  }, [commitUndoNow]);

  const undoOnce = useCallback(() => {
    const u = undoRef.current;
    if (u.stack.length === 0) return;
    if (u.index <= 0) return;
    u.index -= 1;
    persistUndo();
    const snap = u.stack[u.index];
    if (snap) applySnapshot(snap);
  }, [applySnapshot, persistUndo]);

  // Keep refs in sync + record undo history (debounced).
  useEffect(() => {
    linesRef.current = lines;
    activeIndexRef.current = activeIndex;
    scheduleUndoCommit();
  }, [activeIndex, lines, scheduleUndoCommit]);

  // Load persisted undo history on first mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(UNDO_STORAGE_KEY);
      if (!raw) {
        // Seed initial snapshot.
        pushUndoSnapshot({ lines: [{ latex: "", text: "" }], activeIndex: 0 });
        return;
      }
      const parsed = JSON.parse(raw) as
        | { v?: number; stack?: UndoSnapshot[]; index?: number }
        | undefined;
      const stack = Array.isArray(parsed?.stack) ? parsed!.stack! : [];
      const index = typeof parsed?.index === "number" ? parsed!.index! : stack.length - 1;
      if (stack.length === 0) {
        pushUndoSnapshot({ lines: [{ latex: "", text: "" }], activeIndex: 0 });
        return;
      }
      const safeIndex = Math.max(0, Math.min(index, stack.length - 1));
      undoRef.current.stack = stack;
      undoRef.current.index = safeIndex;
      undoRef.current.lastSig = snapshotSignature(stack[safeIndex]);
      applySnapshot(stack[safeIndex]);
    } catch {
      // If anything goes wrong, fall back to fresh history.
      undoRef.current.stack = [];
      undoRef.current.index = 0;
      undoRef.current.lastSig = null;
      pushUndoSnapshot({ lines: [{ latex: "", text: "" }], activeIndex: 0 });
    }
  }, [UNDO_STORAGE_KEY, applySnapshot, pushUndoSnapshot, snapshotSignature]);

  // Ctrl/Cmd+Z => undo (works even after a line is deleted).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z");
      if (!isUndo) return;

      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      const isInputLike =
        (!!t && (tag === "input" || tag === "textarea" || (t as HTMLElement).isContentEditable)) ||
        false;

      // Allow native undo in "real" inputs, but still handle MathQuill's hidden textarea.
      const isMathQuillTextarea =
        tag === "textarea" && (t?.classList?.contains("mq-textarea") ?? false);
      if (isInputLike && !isMathQuillTextarea) return;

      e.preventDefault();
      e.stopPropagation();
      undoOnce();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [undoOnce]);

  const CONSTANTS_MAP = (constantsData as unknown as { CONSTANTS_MAP: Record<string, number> })
    .CONSTANTS_MAP;

  const FORMULA_TREE = (formulasData as unknown as { POPUP_TREE: FormulaTree }).POPUP_TREE;

  const [constants, setConstants] = useState<ConstantDef[]>(() => {
    const entries = Object.entries(CONSTANTS_MAP ?? {});
    entries.sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([key, value]) => ({ key, label: "", value }));
  });

  const constantsMapForEval = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of constants) {
      if (!isValidConstEmbedKey(c.key)) continue;
      m[c.key] = c.value;
    }
    return m;
  }, [constants]);

  const [formulaNav, setFormulaNav] = useState<Array<{ id: string; title: string }>>([
    { id: "root", title: "Formulas" },
  ]);
  const [formulaSearch, setFormulaSearch] = useState("");

  const addConstant = useCallback(() => {
    setConstants((prev) => {
      const used = new Set(prev.map((c) => c.key));
      let n = 1;
      let key = `c${n}`;
      while (used.has(key)) {
        n++;
        key = `c${n}`;
      }
      return [...prev, { key, label: "", value: 1 }];
    });
  }, []);

  const removeConstant = useCallback((key: string) => {
    setConstants((prev) => prev.filter((c) => c.key !== key));
  }, []);

  const updateConstantValue = useCallback((key: string, value: number) => {
    setConstants((prev) =>
      prev.map((c) => (c.key === key ? { ...c, value } : c))
    );
  }, []);

  const updateConstantLabel = useCallback((key: string, label: string) => {
    setConstants((prev) =>
      prev.map((c) => (c.key === key ? { ...c, label } : c))
    );
  }, []);

  const results = useMemo(() => evaluateLines(lines, angleUnit, constantsMapForEval), [
    lines,
    angleUnit,
    constantsMapForEval,
  ]);

  const updateLine = useCallback(
    (index: number, latex: string, text: string) => {
      setLines((prev) => {
        const next = [...prev];
        const expr = toMathExpression(latex, text);
        next[index] = { latex, text: expr };
        return next;
      });
    },
    []
  );

  const removeLine = useCallback((index: number) => {
    // Ensure we have a snapshot *before* deletion so undo can restore it.
    commitUndoNow();
    let nextFocusIndex = 0;
    setLines((prev) => {
      // Always keep at least one line.
      if (prev.length <= 1) {
        nextFocusIndex = 0;
        // Keep refs aligned with the single remaining line.
        fieldRefs.current = fieldRefs.current.slice(0, 1);
        return [{ latex: "", text: "" }];
      }

      const next = [...prev];
      next.splice(index, 1);

      // Keep refs aligned with `lines`.
      fieldRefs.current.splice(index, 1);

      nextFocusIndex = Math.max(0, index - 1);
      return next;
    });

    requestAnimationFrame(() => {
      setActiveIndex(nextFocusIndex);
      fieldRefs.current[nextFocusIndex]?.focus();
    });
  }, [commitUndoNow]);

  const addLineAfter = useCallback((index: number) => {
    // Snapshot before we insert a new row.
    commitUndoNow();
    setLines((prev) => {
      const next = [...prev];
      next.splice(index + 1, 0, { latex: "", text: "" });
      return next;
    });
    requestAnimationFrame(() => {
      const nextIndex = index + 1;
      setActiveIndex(nextIndex);
      fieldRefs.current[nextIndex]?.focus();
    });
  }, [commitUndoNow]);

  const writeToActive = useCallback(
    (latex: string) => {
      const mf = fieldRefs.current[activeIndex];
      if (!mf) return;
      mf.write(latex);
      mf.focus();
      updateLine(activeIndex, mf.latex(), mf.text());
    },
    [activeIndex, updateLine]
  );

  const keystrokeActive = useCallback(
    (keys: string) => {
      const mf = fieldRefs.current[activeIndex];
      if (!mf?.keystroke) return;
      mf.keystroke(keys);
      mf.focus();
      updateLine(activeIndex, mf.latex(), mf.text());
    },
    [activeIndex, updateLine]
  );

  const closeFormulas = useCallback(() => setFormulasOpen(false), []);
  const toggleFormulas = useCallback(() => {
    setFormulasOpen((v) => {
      const next = !v;
      if (next) setConstantsOpen(false);
      return next;
    });
  }, []);

  const closeConstants = useCallback(() => setConstantsOpen(false), []);
  const toggleConstants = useCallback(
    () =>
      setConstantsOpen((v) => {
        const next = !v;
        if (next) setFormulasOpen(false);
        return next;
      }),
    []
  );

  const insertConstantBadge = useCallback(
    (key: string) => {
      if (!isValidConstEmbedKey(key)) return;
      writeToActive(`\\embed{const}[${key}] `);
    },
    [writeToActive]
  );

  const currentFormulaNode = formulaNav[formulaNav.length - 1]?.id ?? "root";
  const currentFormulaItems = (FORMULA_TREE[currentFormulaNode] ?? []) as FormulaTreeItem[];

  const allFormulaLeaves = useMemo(() => {
    const leaves: Array<{ path: string[]; text: string; value: string }> = [];
    const seen = new Set<string>();

    function walk(nodeId: string, pathTitles: string[]) {
      if (seen.has(nodeId)) return;
      seen.add(nodeId);
      const items = FORMULA_TREE[nodeId] ?? [];
      for (const it of items) {
        if ("value" in it && typeof it.value === "string") {
          leaves.push({ path: pathTitles, text: it.text, value: it.value });
        } else if ("next" in it && typeof it.next === "string") {
          walk(it.next, [...pathTitles, it.text]);
        }
      }
    }

    walk("root", []);
    return leaves;
  }, [FORMULA_TREE]);

  const filteredLeafResults = useMemo(() => {
    const q = formulaSearch.trim().toLowerCase();
    if (!q) return [];
    return allFormulaLeaves
      .filter((l) => {
        const label = l.text.toLowerCase();
        const path = l.path.join(" / ").toLowerCase();
        return label.includes(q) || path.includes(q);
      })
      .slice(0, 80);
  }, [allFormulaLeaves, formulaSearch]);

  useEffect(() => {
    // Keep the calculator left-anchored while animating so it doesn't "grow from center".
    // Once the constants window is fully closed, re-center the calculator window.
    if (formulasOpen) {
      setCalcAnchor("right");
      setCalcCentered(false);
      return;
    }
    if (constantsOpen) {
      setCalcAnchor("left");
      setCalcCentered(false);
      return;
    }
    const t = window.setTimeout(() => setCalcCentered(true), 240);
    return () => window.clearTimeout(t);
  }, [constantsOpen, formulasOpen]);

  return (
    <div className="min-h-screen p-6">
      <div
        className={[
          // Keep the calculator window left-anchored so width changes feel like they
          // expand/contract from the left edge (not re-centering mid-transition).
          "w-full transition-[max-width] duration-240 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
          calcCentered ? "mx-auto" : calcAnchor === "left" ? "mr-auto" : "ml-auto",
          drawerOpen
            ? // When the right "window" is open (50vw), constrain the calculator to the remaining space
              // inside the same page padding (p-6 => 3rem total horizontal padding).
              "max-w-[min(64rem,calc(50vw-3rem))] drawer-open"
            : "max-w-[calc(100vw-3rem)]",
        ].join(" ")}
      >
        <Card
          className={[
            "w-full backdrop-blur-md h-[calc(100vh-3rem)]",
            "transition-opacity duration-240 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
            drawerOpen ? "opacity-60" : "opacity-100",
          ].join(" ")}
        >
          <CardContent className="h-full flex flex-col gap-4 overflow-hidden">
            {/* Top toolbar */}
            <div className="flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={toggleFormulas}>
                  Formulas
                </Button>
                <Button size="sm" variant="outline" onClick={toggleConstants}>
                  Constants
                </Button>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-foreground/70">Angle:</span>
                <div className="inline-flex rounded-md border border-foreground/15 bg-foreground/5 p-0.5">
                  <Button
                    size="sm"
                    variant={angleUnit === "rad" ? "default" : "ghost"}
                    onClick={() => setAngleUnit("rad")}
                    aria-pressed={angleUnit === "rad"}
                    className={[
                      "min-w-14 px-4",
                      angleUnit === "rad" ? "shadow-sm" : "text-foreground/70",
                    ].join(" ")}
                  >
                    RAD
                  </Button>
                  <Button
                    size="sm"
                    variant={angleUnit === "deg" ? "default" : "ghost"}
                    onClick={() => setAngleUnit("deg")}
                    aria-pressed={angleUnit === "deg"}
                    className={[
                      "min-w-14 px-4",
                      angleUnit === "deg" ? "shadow-sm" : "text-foreground/70",
                    ].join(" ")}
                  >
                    DEG
                  </Button>
                </div>
              </div>
            </div>

            {/* Math field (top) */}
            <div className="min-h-[180px] flex-1 rounded-xl border border-foreground/10 bg-background/25 backdrop-blur-md shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12)] overflow-auto p-3">
              <div className="space-y-2">
                {lines.map((line, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="flex w-full items-center gap-3 min-h-12 px-3 py-2 rounded-lg border border-foreground/10 bg-foreground/5 text-lg focus-within:ring-2 focus-within:ring-foreground/15">
                      <MathQuillField
                        latex={line.latex}
                        onChange={(latex, text) => updateLine(i, latex, text)}
                        onEnter={() => addLineAfter(i)}
                        onFocus={() => setActiveIndex(i)}
                        onBackspaceWhenEmpty={() => removeLine(i)}
                        constants={constants}
                        onUpdateConstant={updateConstantValue}
                        onMount={(mf) => {
                          fieldRefs.current[i] = mf as MQFieldApi;
                        }}
                        wrapperClassName="flex-1 min-w-0"
                        fieldClassName="block w-full min-h-10 px-0 py-0 rounded-none border-0 bg-transparent bg-none text-lg focus-within:ring-0"
                      />

                      <div className="shrink-0 max-w-[45%] overflow-hidden pl-3 border-l border-foreground/10 text-right text-lg tabular-nums text-foreground/80 pointer-events-none mq-toolbar-icon">
                        {results[i]?.latex ? (
                          <StaticMathField>{results[i].latex}</StaticMathField>
                        ) : (
                          ""
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Divider */}
            <div className="shrink-0 h-px bg-foreground/10" />

            {/* Keypad (bottom) - scrollable when space is tight */}
            <div className="min-h-0 shrink overflow-auto">
              <div className="grid gap-2 sm:gap-4 max-md:grid-cols-1 grid-cols-[minmax(0,0.95fr)_minmax(0,1.25fr)_minmax(0,0.8fr)]">
              {/* Left panel: scientific */}
              <div className="rounded-xl border border-foreground/10 bg-foreground/5 backdrop-blur-sm p-3">
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("^{2}")}
                  >
                    <span className="mq-toolbar-icon calc-legend">
                      <StaticMathField>{"a^{2}"}</StaticMathField>
                    </span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("^{}")}
                  >
                    <span className="mq-toolbar-icon calc-legend">
                      <StaticMathField>{"a^{b}"}</StaticMathField>
                    </span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("\\left|\\right|")}
                  >
                    <span className="mq-toolbar-icon calc-legend">
                      <StaticMathField>{"\\left|a\\right|"}</StaticMathField>
                    </span>
                  </Button>

                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("\\sqrt{}")}
                  >
                    <span className="mq-toolbar-icon calc-legend">
                      <StaticMathField>{"\\sqrt{x}"}</StaticMathField>
                    </span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("\\sqrt[n]{}")}
                  >
                    <span className="mq-toolbar-icon calc-legend">
                      <StaticMathField>{"\\sqrt[n]{x}"}</StaticMathField>
                    </span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("\\pi ")}
                  >
                    <span className="mq-toolbar-icon calc-legend">
                      <StaticMathField>{"\\pi"}</StaticMathField>
                    </span>
                  </Button>

                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("sin\\left(\\right)")}
                  >
                    <span className="calc-legend">sin</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("cos\\left(\\right)")}
                  >
                    <span className="calc-legend">cos</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("tan\\left(\\right)")}
                  >
                    <span className="calc-legend">tan</span>
                  </Button>

                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("(")}
                  >
                    <span className="calc-legend">(</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive(")")}
                  >
                    <span className="calc-legend">)</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive(",")}
                  >
                    <span className="calc-legend">,</span>
                  </Button>
                </div>
              </div>

              {/* Middle panel: numbers + ops */}
              <div className="rounded-xl border border-foreground/10 bg-foreground/5 backdrop-blur-sm p-3">
                <div className="grid grid-cols-4 gap-2">
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => writeToActive("7")}
                  >
                    <span className="calc-legend">7</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => writeToActive("8")}
                  >
                    <span className="calc-legend">8</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => writeToActive("9")}
                  >
                    <span className="calc-legend">9</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("\\div ")}
                  >
                    <span className="calc-legend">÷</span>
                  </Button>

                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => writeToActive("4")}
                  >
                    <span className="calc-legend">4</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => writeToActive("5")}
                  >
                    <span className="calc-legend">5</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => writeToActive("6")}
                  >
                    <span className="calc-legend">6</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("\\times ")}
                  >
                    <span className="calc-legend">×</span>
                  </Button>

                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => writeToActive("1")}
                  >
                    <span className="calc-legend">1</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => writeToActive("2")}
                  >
                    <span className="calc-legend">2</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => writeToActive("3")}
                  >
                    <span className="calc-legend">3</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("-")}
                  >
                    <span className="calc-legend">−</span>
                  </Button>

                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => writeToActive("0")}
                  >
                    <span className="calc-legend">0</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => writeToActive(".")}
                  >
                    <span className="calc-legend">.</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/35"
                    onClick={() => writeToActive("ans")}
                  >
                    <span className="calc-legend">ans</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("+")}
                  >
                    <span className="calc-legend">+</span>
                  </Button>
                </div>
              </div>

              {/* Right panel: misc + nav + actions */}
              <div className="rounded-xl border border-foreground/10 bg-foreground/5 backdrop-blur-sm p-3">
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("i")}
                  >
                    <span className="calc-legend">i</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-background/20"
                    onClick={() => writeToActive("\\frac{}{}")}
                  >
                    <span className="mq-toolbar-icon calc-legend">
                      <StaticMathField>{"\\frac{a}{b}"}</StaticMathField>
                    </span>
                  </Button>

                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => keystrokeActive("Left")}
                    title="Move cursor left"
                  >
                    <ArrowLeft className="h-5 w-5" />
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => keystrokeActive("Right")}
                    title="Move cursor right"
                  >
                    <ArrowRight className="h-5 w-5" />
                  </Button>

                  <Button
                    variant="outline"
                    className="col-span-2 h-10 sm:h-12 lg:h-14 bg-foreground/10"
                    onClick={() => keystrokeActive("Backspace")}
                    title="Backspace"
                  >
                    <Delete className="h-5 w-5" />
                  </Button>

                  <Button
                    className="col-span-2 h-10 sm:h-12 lg:h-14"
                    onClick={() => addLineAfter(activeIndex)}
                    title="Enter / new line"
                  >
                    <CornerDownLeft className={`h-5 w-5 ${drawerOpen ? "mr-0" : "mr-2"}`} />
                    <span className="calc-legend">Enter</span>
                  </Button>
                </div>
              </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Backdrop for side drawers (always rendered for smooth transitions) */}
      <div
        className={[
          "fixed inset-0 z-40 bg-black/20 backdrop-blur-lg",
          "transition-[opacity,backdrop-filter] duration-240 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
          drawerOpen ? "opacity-100" : "opacity-0 pointer-events-none",
        ].join(" ")}
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          closeConstants();
          closeFormulas();
        }}
      />

      {/* Separate "window" that slides in from the left edge */}
      <div
        className={[
          "fixed left-0 top-0 z-50 h-dvh w-[50vw] max-md:w-screen p-6",
          "transition-transform duration-240 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
          formulasOpen ? "translate-x-0" : "-translate-x-full",
        ].join(" ")}
        aria-hidden={!formulasOpen}
      >
        <Card className="h-full w-full backdrop-blur-md shadow-[0_16px_48px_0_rgba(0,0,0,0.25)]">
          <CardContent className="h-full flex flex-col gap-3 overflow-hidden">
            <div className="flex items-center justify-between shrink-0">
              <div className="text-sm font-medium">Formulas</div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={closeFormulas}>
                  Close
                </Button>
              </div>
            </div>

            <div className="shrink-0 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setFormulaNav((prev) =>
                      prev.length > 1 ? prev.slice(0, -1) : prev
                    );
                  }}
                  disabled={formulaNav.length <= 1}
                >
                  Back
                </Button>
                <div className="min-w-0 flex-1 text-xs text-foreground/70 truncate">
                  {formulaNav
                    .map((n, idx) => (idx === 0 ? "root" : n.title))
                    .join(" / ")}
                </div>
              </div>

              <input
                className="w-full rounded-md border border-foreground/15 bg-white/10 px-2 py-1 text-sm shadow-[inset_0_4px_12px_0_rgba(0,0,0,0.15)]"
                value={formulaSearch}
                onChange={(e) => setFormulaSearch(e.target.value)}
                placeholder="Search formulas…"
              />
            </div>

            <div className="flex-1 overflow-auto pr-1 space-y-2">
              {formulaSearch.trim() ? (
                filteredLeafResults.length === 0 ? (
                  <div className="text-sm text-foreground/60">No matches.</div>
                ) : (
                  filteredLeafResults.map((leaf, idx) => {
                    const latex = expressionToLatexWithConstEmbeds(
                      leaf.value,
                      constantsMapForEval
                    );
                    return (
                      <button
                        key={`${leaf.path.join("/")}:${leaf.text}:${idx}`}
                        type="button"
                        className="w-full text-left rounded-md border border-foreground/15 bg-white/15 text-white p-3 space-y-2 shadow-[0_4px_12px_0_rgba(0,0,0,0.15)] hover:bg-white/20 transition-colors"
                        onClick={() => writeToActive(latex)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-sm font-medium">{leaf.text}</div>
                          <div className="text-[11px] text-foreground/60 text-right">
                            {leaf.path.join(" / ")}
                          </div>
                        </div>
                        <div className="text-lg text-foreground/90">
                          <StaticMathField>{latex}</StaticMathField>
                        </div>
                      </button>
                    );
                  })
                )
              ) : currentFormulaItems.length === 0 ? (
                <div className="text-sm text-foreground/60">
                  Empty category (or missing node): <span className="font-mono">{currentFormulaNode}</span>
                </div>
              ) : (
                currentFormulaItems.map((it, idx) => {
                  if ("next" in it && typeof it.next === "string") {
                    const hasNode = Array.isArray(FORMULA_TREE[it.next]);
                    return (
                      <button
                        key={`${it.next}:${idx}`}
                        type="button"
                        className="w-full text-left rounded-md border border-foreground/15 bg-white/15 text-white p-3 shadow-[0_4px_12px_0_rgba(0,0,0,0.15)] hover:bg-white/20 transition-colors"
                        onClick={() => {
                          setFormulaNav((prev) => [...prev, { id: it.next, title: it.text }]);
                        }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-medium">{it.text}</div>
                          <div className="text-xs text-foreground/60">
                            {hasNode ? "Open" : "Missing"}
                          </div>
                        </div>
                      </button>
                    );
                  }

                  const latex = expressionToLatexWithConstEmbeds(
                    it.value,
                    constantsMapForEval
                  );
                  const disabled = String(it.value).trim().toLowerCase() === "stop";
                  return (
                    <button
                      key={`${it.text}:${idx}`}
                      type="button"
                      disabled={disabled}
                      className={[
                        "w-full text-left rounded-md border border-foreground/15 bg-white/15 text-white p-3 space-y-2 shadow-[0_4px_12px_0_rgba(0,0,0,0.15)] transition-colors",
                        disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-white/20",
                      ].join(" ")}
                      onClick={() => {
                        if (disabled) return;
                        writeToActive(latex);
                      }}
                    >
                      <div className="text-sm font-medium">{it.text}</div>
                      {!disabled ? (
                        <div className="text-lg text-foreground/90">
                          <StaticMathField>{latex}</StaticMathField>
                        </div>
                      ) : (
                        <div className="text-sm text-foreground/60">Not available yet.</div>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div
        className={[
          "fixed right-0 top-0 z-50 h-dvh w-[50vw] max-md:w-screen p-6",
          "transition-transform duration-240 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
          constantsOpen ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
        aria-hidden={!constantsOpen}
      >
        <Card className="h-full w-full backdrop-blur-md shadow-[0_16px_48px_0_rgba(0,0,0,0.25)]">
          <CardContent className="h-full flex flex-col gap-3 overflow-hidden">
            <div className="flex items-center justify-between shrink-0">
              <div className="text-sm font-medium">Constants</div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={addConstant}>
                  Add
                </Button>
                <Button size="sm" variant="ghost" onClick={closeConstants}>
                  Close
                </Button>
              </div>
            </div>

            <div className="flex-1 overflow-auto pr-1 space-y-2">
              {constants.map((c) => (
                <div
                  key={c.key}
                  className="rounded-md border border-foreground/15 bg-white/15 text-white p-2 space-y-2 shadow-[0_4px_12px_0_rgba(0,0,0,0.15)]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{c.key}</div>
                      {!isValidConstEmbedKey(c.key) ? (
                        <div className="text-xs text-foreground/60">
                          Invalid key (can’t insert as badge)
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!isValidConstEmbedKey(c.key)}
                        onClick={() => insertConstantBadge(c.key)}
                      >
                        Insert
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeConstant(c.key)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                  <label className="block text-xs text-foreground/60">Label</label>
                  <input
                    className="w-full rounded-md border border-foreground/15 bg-white/10 px-2 py-1 text-sm shadow-[inset_0_4px_12px_0_rgba(0,0,0,0.15)]"
                    value={c.label}
                    onChange={(e) => updateConstantLabel(c.key, e.target.value)}
                    placeholder="Optional description"
                  />
                  <label className="block text-xs text-foreground/60">Value</label>
                  <input
                    className="w-full rounded-md border border-foreground/15 bg-white/10 px-2 py-1 text-sm shadow-[inset_0_4px_12px_0_rgba(0,0,0,0.15)]"
                    inputMode="decimal"
                    value={String(c.value)}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) updateConstantValue(c.key, n);
                    }}
                  />
                </div>
              ))}
              {constants.length === 0 ? (
                <div className="text-sm text-foreground/60">
                  No constants yet. Click “Add”.
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
