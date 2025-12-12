"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import { create, all, type MathJsStatic } from "mathjs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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

type MQFieldApi = {
  focus: () => void;
  write: (latex: string) => void;
  latex: () => string;
  text: () => string;
};

const CONST_ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function insertImplicitMultiplication(expr: string) {
  // Make common calculator-style inputs mathjs-friendly:
  // - 2(3) => 2*(3)
  // - (2)3 => (2)*3
  // - 2pi => 2*pi
  // - 2sin(3) => 2*sin(3)
  // - x(y) => x*(y)
  // - 2x => 2*x
  let out = expr;

  const functionNames = new Set([
    "sin",
    "cos",
    "tan",
    "sec",
    "csc",
    "cot",
    "asin",
    "acos",
    "atan",
    "sinh",
    "cosh",
    "tanh",
    "asinh",
    "acosh",
    "atanh",
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
  ]);

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

  replaceLoop(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, (_m, num, den) => {
    return `((${num})/(${den}))`;
  });
  replaceLoop(/\\sqrt\{([^{}]+)\}/g, (_m, inner) => {
    return `sqrt(${inner})`;
  });
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
  return insertImplicitMultiplication(normalizeExpression(base));
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
      if (typeof res === "number") res = normalizeNumber(res);
      if (res !== undefined) lastAns = res;
      out.push({ latex: resultToLatex(res), raw: res });
    } catch {
      out.push({ latex: "\\dots", raw: "…" });
    }
  }
  return out;
}

export default function Home() {
  const [lines, setLines] = useState<Line[]>([{ latex: "", text: "" }]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [angleUnit, setAngleUnit] = useState<"deg" | "rad">("rad");
  const fieldRefs = useRef<Array<MQFieldApi | null>>([]);

  const [constants, setConstants] = useState<ConstantDef[]>([
    { key: "k", label: "Coulomb constant (example)", value: 8.9875517923e9 },
    { key: "g", label: "Gravity (m/s^2)", value: 9.80665 },
    { key: "R", label: "Gas constant", value: 8.314462618 },
    { key: "c0", label: "Speed of light", value: 299792458 },
  ]);

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

  const addLineAfter = useCallback((index: number) => {
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
  }, []);

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

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-5xl backdrop-blur-md">
        <CardHeader>
          <CardTitle>Scientific Calculator (minimal)</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 md:grid-cols-[1fr_300px]">
          <div className="space-y-4">
            <div className="flex items-center justify-end gap-2">
              <span className="text-sm text-foreground/70">Angle:</span>
              <div className="inline-flex rounded-md border border-foreground/15 p-0.5">
                <Button
                  size="sm"
                  variant={angleUnit === "rad" ? "default" : "ghost"}
                  onClick={() => setAngleUnit("rad")}
                  className={
                    angleUnit === "rad"
                      ? "shadow-[0_4px_12px_0_rgba(0,0,0,0.15)] bg-white/30 text-black/80 hover:bg-white/40"
                      : undefined
                  }
                >
                  RAD
                </Button>
                <Button
                  size="sm"
                  variant={angleUnit === "deg" ? "default" : "ghost"}
                  onClick={() => setAngleUnit("deg")}
                  className={
                    angleUnit === "deg"
                      ? "shadow-[0_4px_12px_0_rgba(0,0,0,0.15)] bg-white/30 text-black/80 hover:bg-white/40"
                      : undefined
                  }
                >
                  DEG
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 bg-[unset] [background:unset]">
              <Button variant="outline" onClick={() => writeToActive("+")}>
                +
              </Button>
              <Button variant="outline" onClick={() => writeToActive("-")}>
                −
              </Button>
              <Button
                variant="outline"
                onClick={() => writeToActive("\\times ")}
              >
                ×
              </Button>
              <Button
                variant="outline"
                onClick={() => writeToActive("\\div ")}
              >
                ÷
              </Button>
              <Button
                variant="ghost"
                onClick={() => writeToActive("sin\\left(\\right)")}
              >
                sin
              </Button>
              <Button
                variant="ghost"
                onClick={() => writeToActive("cos\\left(\\right)")}
              >
                cos
              </Button>
              <Button
                variant="ghost"
                onClick={() => writeToActive("tan\\left(\\right)")}
              >
                tan
              </Button>
              <Button variant="ghost" onClick={() => writeToActive("\\sqrt{}")}>
                √
              </Button>
            </div>

            <div className="space-y-2">
              <div className="text-xs text-foreground/60">Constants</div>
              <div className="flex flex-wrap gap-2">
                {constants
                  .filter((c) => CONST_ID_RE.test(c.key))
                  .map((c) => (
                    <Button
                      key={c.key}
                      size="sm"
                      variant="outline"
                      onClick={() => writeToActive(`\\embed{const}[${c.key}] `)}
                    >
                      {c.key}
                    </Button>
                  ))}
              </div>
            </div>

            <div className="space-y-3">
              {lines.map((line, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_auto] gap-3 items-start"
                >
                  <MathQuillField
                    latex={line.latex}
                    onChange={(latex, text) => updateLine(i, latex, text)}
                    onEnter={() => addLineAfter(i)}
                    onFocus={() => setActiveIndex(i)}
                  constants={constants}
                    onUpdateConstant={updateConstantValue}
                    onMount={(mf) => {
                      fieldRefs.current[i] = mf as MQFieldApi;
                    }}
                  />
                  <div className="min-w-24 text-right text-lg tabular-nums text-foreground/80 pt-1">
                    {results[i]?.latex ? (
                      <StaticMathField>{results[i].latex}</StaticMathField>
                    ) : (
                      ""
                    )}
                  </div>
                </div>
              ))}
            </div>

            <p className="text-sm text-foreground/60">
              Type directly: <code>sqrt</code>, <code>int</code>, <code>sin</code>{" "}
              auto‑convert. Results update live; Enter adds a new line.
            </p>
          </div>

          <aside className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Constants</div>
              <Button size="sm" variant="outline" onClick={addConstant}>
                Add
              </Button>
            </div>
            <div className="space-y-2">
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
          </aside>
        </CardContent>
      </Card>
    </div>
  );
}
