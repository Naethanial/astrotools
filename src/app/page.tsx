"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import { create, all } from "mathjs";
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

const math = create(all, {});

type Line = {
  latex: string;
  text: string;
};

type MQFieldApi = {
  focus: () => void;
  write: (latex: string) => void;
  latex: () => string;
  text: () => string;
};

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
    return math.latex(result as never);
  } catch {
    if (typeof result === "string") return `\\text{${result}}`;
    return String(result);
  }
}

function evaluateLines(
  lines: Line[],
  angleUnit: "deg" | "rad"
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
    scope.asin = (x: number) => math.asin(x) * (180 / Math.PI);
    scope.acos = (x: number) => math.acos(x) * (180 / Math.PI);
    scope.atan = (x: number) => math.atan(x) * (180 / Math.PI);
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

  const results = useMemo(() => evaluateLines(lines, angleUnit), [
    lines,
    angleUnit,
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
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle>Scientific Calculator (minimal)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-end gap-2">
            <span className="text-sm text-foreground/70">Angle:</span>
            <div className="inline-flex rounded-md border border-foreground/15 p-0.5">
              <Button
                size="sm"
                variant={angleUnit === "rad" ? "default" : "ghost"}
                onClick={() => setAngleUnit("rad")}
              >
                RAD
              </Button>
              <Button
                size="sm"
                variant={angleUnit === "deg" ? "default" : "ghost"}
                onClick={() => setAngleUnit("deg")}
              >
                DEG
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
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
        </CardContent>
      </Card>
    </div>
  );
}
