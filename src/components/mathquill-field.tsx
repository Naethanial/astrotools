"use client";

import { EditableMathField, addStyles } from "react-mathquill";
import { useEffect } from "react";

type MathField = unknown;

export type MathQuillFieldProps = {
  latex: string;
  onChange: (latex: string, text: string) => void;
  onEnter: () => void;
  onFocus: () => void;
  onMount: (mathField: MathField) => void;
  autoCommands?: string;
  autoOperatorNames?: string;
};

export function MathQuillField({
  latex,
  onChange,
  onEnter,
  onFocus,
  onMount,
  autoCommands,
  autoOperatorNames,
}: MathQuillFieldProps) {
  const BUILTIN_NAMES = new Set([
    // Common MathQuill built-ins that throw if re-declared.
    "lim",
    "log",
    "ln",
    "exp",
    "abs",
    "floor",
    "ceil",
    "round",
    "mod",
    "gcd",
    "lcm",
    "factorial",
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
    "integral",
    "pi",
    "theta",
    "tau",
    "phi",
  ]);

  const desiredAutoCommands =
    autoCommands ??
    [
      "sqrt",
      "pi",
      "theta",
      "tau",
      "phi",
      "integral",
      "sum",
      "prod",
      "log",
      "ln",
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
    ].join(" ");

  const desiredAutoOperatorNames =
    autoOperatorNames ??
    [
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
      "nCr",
      "nPr",
    ].join(" ");

  const safeAutoCommands = desiredAutoCommands
    .split(/\s+/)
    .filter(Boolean)
    .filter((name) => !BUILTIN_NAMES.has(name))
    .filter((name) => /^[a-zA-Z]+$/.test(name))
    .join(" ");

  const safeAutoOperatorNames = desiredAutoOperatorNames
    .split(/\s+/)
    .filter(Boolean)
    .filter((name) => !BUILTIN_NAMES.has(name))
    .filter((name) => /^[a-zA-Z]+$/.test(name))
    .join(" ");

  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (typeof window === "undefined") return;
      const jqMod = await import("jquery");
      const jq =
        (jqMod as unknown as { default?: unknown }).default ?? (jqMod as unknown);
      (window as unknown as { jQuery?: unknown; $?: unknown }).jQuery = jq;
      (window as unknown as { jQuery?: unknown; $?: unknown }).$ = jq;
      await import("mathquill/build/mathquill.js");
      if (!cancelled) addStyles();
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <EditableMathField
      latex={latex}
      onChange={(mf) => {
        if (!mf) return;
        onChange(mf.latex(), mf.text());
      }}
      mathquillDidMount={(mf) => onMount(mf)}
      onFocus={onFocus}
      config={{
        autoCommands: safeAutoCommands,
        autoOperatorNames: safeAutoOperatorNames,
        handlers: {
          enter: () => onEnter(),
        },
      }}
      className="w-full min-h-10 px-2 py-1 rounded-md border border-foreground/15 bg-background text-lg focus-within:ring-2 focus-within:ring-foreground/20"
    />
  );
}
