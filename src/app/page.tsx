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

type FormulaDef = {
  id: string;
  label: string;
  latex: string;
  previewLatex?: string;
};

type MQFieldApi = {
  focus: () => void;
  write: (latex: string) => void;
  keystroke?: (keys: string) => void;
  latex: () => string;
  text: () => string;
};

const CONST_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const FUNCTION_NAMES = [
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
      const num = parseBraceGroup(out, pos);
      if (!num) {
        idx = out.indexOf("\\frac", idx + 1);
        continue;
      }
      pos = num.end;
      const den = parseBraceGroup(out, pos);
      if (!den) {
        idx = out.indexOf("\\frac", idx + 1);
        continue;
      }
      const replacement = `((${num.content})/(${den.content}))`;
      out = out.slice(0, idx) + replacement + out.slice(den.end);
      idx = out.indexOf("\\frac", idx + replacement.length);
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
  //   \embed{const}[k]  => k
  replaceLoop(/\\embed\{const\}\[([^\]]+)\]/g, (_m, id) => {
    const key = String(id);
    return CONST_ID_RE.test(key) ? key : "const";
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
    .replace(/\s+/g, "");

  // Powers like x^{2}
  expr = expr.replace(
    /([0-9a-zA-Z).]+)\^\{([^{}]+)\}/g,
    (_m, base, power) => `(${base})^(${power})`
  );

  // Strip remaining braces.
  expr = expr.replace(/[{}]/g, "");
  return expr;
}

function normalizeExpression(text: string) {
  let out = text
    .replace(/\s+/g, "")
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
  return insertImplicitMultiplication(withFnCalls);
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

function resultToLatex(result: unknown) {
  try {
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
  constants: ConstantDef[]
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

  // User-defined constants
  for (const c of constants) {
    if (!CONST_ID_RE.test(c.key)) continue;
    scope[c.key] = c.value;
  }

  const out: Array<{ latex: string; raw: unknown }> = [];
  let lastAns: unknown = 0;
  for (const line of lines) {
    const expr = normalizeExpression(line.text);
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
    } catch {
      // Keep the result blank for invalid/incomplete inputs.
      out.push({ latex: "", raw: "" });
    }
  }
  return out;
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

  const [constants, setConstants] = useState<ConstantDef[]>([
    { key: "k", label: "Coulomb constant (example)", value: 8.9875517923e9 },
    { key: "g", label: "Gravity (m/s^2)", value: 9.80665 },
    { key: "R", label: "Gas constant", value: 8.314462618 },
    { key: "c0", label: "Speed of light", value: 299792458 },
  ]);

  const formulas = useMemo<FormulaDef[]>(
    () => [
      {
        id: "quadratic",
        label: "Quadratic formula",
        latex: "x=\\frac{-b\\pm\\sqrt{b^{2}-4ac}}{2a}",
      },
      {
        id: "distance",
        label: "Distance (2D)",
        latex: "d=\\sqrt{(x_{2}-x_{1})^{2}+(y_{2}-y_{1})^{2}}",
      },
      {
        id: "pythagorean",
        label: "Pythagorean theorem",
        latex: "c=\\sqrt{a^{2}+b^{2}}",
      },
      {
        id: "euler",
        label: "Euler's formula",
        latex: "e^{i\\theta}=\\cos\\left(\\theta\\right)+i\\sin\\left(\\theta\\right)",
        previewLatex: "e^{i\\theta}=\\cos\\left(\\theta\\right)+i\\sin\\left(\\theta\\right)",
      },
      {
        id: "derivative",
        label: "Derivative template",
        latex: "\\frac{d}{dx}\\left(\\right)",
        previewLatex: "\\frac{d}{dx}\\left(f\\left(x\\right)\\right)",
      },
      {
        id: "integral",
        label: "Integral template",
        latex: "\\int_{}^{}\\left(\\right)dx",
        previewLatex: "\\int_{a}^{b}f\\left(x\\right)dx",
      },
    ],
    []
  );

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

  const results = useMemo(() => evaluateLines(lines, angleUnit, constants), [
    lines,
    angleUnit,
    constants,
  ]);

  const updateLine = useCallback(
    (index: number, latex: string, text: string) => {
      setLines((prev) => {
        const next = [...prev];
        next[index] = { latex, text: toMathExpression(latex, text) };
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
          formulasOpen || constantsOpen
            ? // When the right "window" is open (50vw), constrain the calculator to the remaining space
              // inside the same page padding (p-6 => 3rem total horizontal padding).
              "max-w-[min(64rem,calc(50vw-3rem))]"
            : "max-w-[calc(100vw-3rem)]",
        ].join(" ")}
      >
        <Card className="w-full backdrop-blur-md h-[calc(100vh-3rem)]">
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
                    className={angleUnit === "rad" ? "shadow-sm" : undefined}
                  >
                    RAD
                  </Button>
                  <Button
                    size="sm"
                    variant={angleUnit === "deg" ? "default" : "ghost"}
                    onClick={() => setAngleUnit("deg")}
                    className={angleUnit === "deg" ? "shadow-sm" : undefined}
                  >
                    DEG
                  </Button>
                </div>
              </div>
            </div>

            {/* Math field (top) */}
            <div className="min-h-0 flex-1 rounded-xl border border-foreground/10 bg-background/25 backdrop-blur-md shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12)] overflow-auto p-3">
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

                      <div className="shrink-0 max-w-[45%] overflow-hidden pl-3 border-l border-foreground/10 text-right text-lg tabular-nums text-foreground/80 pointer-events-none">
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

            {/* Keypad (bottom) */}
            <div className="shrink-0 grid gap-4 max-md:grid-cols-1 grid-cols-[minmax(0,0.95fr)_minmax(0,1.25fr)_minmax(0,0.8fr)]">
              {/* Left panel: scientific */}
              <div className="rounded-xl border border-foreground/10 bg-foreground/5 backdrop-blur-sm p-3">
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("^{2}")}
                  >
                    <span className="mq-toolbar-icon">
                      <StaticMathField>{"a^{2}"}</StaticMathField>
                    </span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("^{}")}
                  >
                    <span className="mq-toolbar-icon">
                      <StaticMathField>{"a^{b}"}</StaticMathField>
                    </span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("\\left|\\right|")}
                  >
                    <span className="mq-toolbar-icon">
                      <StaticMathField>{"\\left|a\\right|"}</StaticMathField>
                    </span>
                  </Button>

                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("\\sqrt{}")}
                  >
                    <span className="mq-toolbar-icon">
                      <StaticMathField>{"\\sqrt{}"}</StaticMathField>
                    </span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("\\sqrt[n]{}")}
                  >
                    <span className="mq-toolbar-icon">
                      <StaticMathField>{"\\sqrt[n]{}"}</StaticMathField>
                    </span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("\\pi ")}
                  >
                    <span className="mq-toolbar-icon">
                      <StaticMathField>{"\\pi"}</StaticMathField>
                    </span>
                  </Button>

                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("sin\\left(\\right)")}
                  >
                    sin
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("cos\\left(\\right)")}
                  >
                    cos
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("tan\\left(\\right)")}
                  >
                    tan
                  </Button>

                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("(")}
                  >
                    (
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive(")")}
                  >
                    )
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive(",")}
                  >
                    ,
                  </Button>
                </div>
              </div>

              {/* Middle panel: numbers + ops */}
              <div className="rounded-xl border border-foreground/10 bg-foreground/5 backdrop-blur-sm p-3">
                <div className="grid grid-cols-4 gap-2">
                  <Button
                    variant="outline"
                    className="h-14 bg-foreground/10"
                    onClick={() => writeToActive("7")}
                  >
                    7
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-foreground/10"
                    onClick={() => writeToActive("8")}
                  >
                    8
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-foreground/10"
                    onClick={() => writeToActive("9")}
                  >
                    9
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("\\div ")}
                  >
                    ÷
                  </Button>

                  <Button
                    variant="outline"
                    className="h-14 bg-foreground/10"
                    onClick={() => writeToActive("4")}
                  >
                    4
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-foreground/10"
                    onClick={() => writeToActive("5")}
                  >
                    5
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-foreground/10"
                    onClick={() => writeToActive("6")}
                  >
                    6
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("\\times ")}
                  >
                    ×
                  </Button>

                  <Button
                    variant="outline"
                    className="h-14 bg-foreground/10"
                    onClick={() => writeToActive("1")}
                  >
                    1
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-foreground/10"
                    onClick={() => writeToActive("2")}
                  >
                    2
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-foreground/10"
                    onClick={() => writeToActive("3")}
                  >
                    3
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("-")}
                  >
                    −
                  </Button>

                  <Button
                    variant="outline"
                    className="h-14 bg-foreground/10"
                    onClick={() => writeToActive("0")}
                  >
                    0
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-foreground/10"
                    onClick={() => writeToActive(".")}
                  >
                    .
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/35"
                    onClick={() => writeToActive("ans")}
                  >
                    ans
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("+")}
                  >
                    +
                  </Button>
                </div>
              </div>

              {/* Right panel: misc + nav + actions */}
              <div className="rounded-xl border border-foreground/10 bg-foreground/5 backdrop-blur-sm p-3">
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("i")}
                  >
                    i
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-background/20"
                    onClick={() => writeToActive("\\frac{}{}")}
                  >
                    <StaticMathField>{"\\frac{a}{b}"}</StaticMathField>
                  </Button>

                  <Button
                    variant="outline"
                    className="h-14 bg-foreground/10"
                    onClick={() => keystrokeActive("Left")}
                    title="Move cursor left"
                  >
                    <ArrowLeft className="h-5 w-5" />
                  </Button>
                  <Button
                    variant="outline"
                    className="h-14 bg-foreground/10"
                    onClick={() => keystrokeActive("Right")}
                    title="Move cursor right"
                  >
                    <ArrowRight className="h-5 w-5" />
                  </Button>

                  <Button
                    variant="outline"
                    className="col-span-2 h-14 bg-foreground/10"
                    onClick={() => keystrokeActive("Backspace")}
                    title="Backspace"
                  >
                    <Delete className="h-5 w-5" />
                  </Button>

                  <Button
                    className="col-span-2 h-14"
                    onClick={() => addLineAfter(activeIndex)}
                    title="Enter / new line"
                  >
                    <CornerDownLeft className="h-5 w-5 mr-2" />
                    Enter
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Backdrop for side drawers */}
      {formulasOpen || constantsOpen ? (
        <div
          className="fixed inset-0 z-40 bg-black/20"
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return;
            closeConstants();
            closeFormulas();
          }}
        />
      ) : null}

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

            <div className="flex-1 overflow-auto pr-1 space-y-2">
              {formulas.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="w-full text-left rounded-md border border-foreground/15 bg-white/15 text-white p-3 space-y-2 shadow-[0_4px_12px_0_rgba(0,0,0,0.15)] hover:bg-white/20 transition-colors"
                  onClick={() => writeToActive(f.latex)}
                >
                  <div className="text-sm font-medium">{f.label}</div>
                  <div className="text-lg text-foreground/90">
                    <StaticMathField>
                      {f.previewLatex ?? f.latex}
                    </StaticMathField>
                  </div>
                </button>
              ))}
              {formulas.length === 0 ? (
                <div className="text-sm text-foreground/60">No formulas yet.</div>
              ) : null}
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
                    <div className="text-sm font-medium">
                      {CONST_ID_RE.test(c.key) ? c.key : "(invalid key)"}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeConstant(c.key)}
                    >
                      Remove
                    </Button>
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
